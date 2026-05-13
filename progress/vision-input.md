# Stage 15: 图片输入（vision）

## 动机

Trellis 当前 question 只能是纯文本。GPT 网页客户端最高频的两种动作之一是「截图问 bug / 设计 / 数据」——这一档不通，Chat 模式就只能干一半的活。Stage 15 把节点 question 升级成「文本 + 图片附件」的多模态输入。

涉及三个 mode 都要支持（Chat / Workspace / Project），因为 vision 不是 mode 特性，是 question 本身的形态。

## CLI 能力（spike 已确认）

| CLI | 接入方式 | 命令实例 |
|---|---|---|
| claude | `--input-format stream-json`，stdin 喂 JSONL，每条 `{type:"user", message:{role:"user", content:[{type:"image", source:{type:"base64", media_type, data}}, {type:"text", text}]}}` | 已实测 chat / workspace 两档都跑通 |
| codex | `--image FILE...` flag（repeatable），prompt 仍走 `prompt` 位置参数 | 已实测 ephemeral chat 跑通 |

差异：claude 吃 base64（stdin 推），codex 吃文件路径（CLI 参数）。

→ trellis 内部统一存「服务端文件」，spawn 时 claude 路径读 → base64 推 stdin，codex 路径直接 `--image <path>`。

## 设计

### 存储策略

**不进 SQLite。** 走文件系统：

```
~/.trellis/
  data.db
  blobs/
    <sha256-of-content>.<ext>   ← 命名按 content hash，天然去重
```

- 每张图按 SHA-256 内容哈希命名 + 原扩展名（`.png` / `.jpg` / `.webp` / `.gif`）
- 同一张图多次粘贴只占一份磁盘
- DB 只存元信息（hash, mime, size, original filename），不存 base64 → SQLite WAL 文件不膨胀
- session 删除时不立即清理 blob —— attachment hash 可能被多个 session 引用；做个启动时的 GC 扫描（统计哪些 hash 在 DB 里被引用，删孤儿）

**为什么不用 base64 进 DB**：
- 一张 1MB 截图 = 1.4MB base64，SQLite WAL 会一直留着旧版本直到 checkpoint
- 多张图的 question 行直接膨胀几 MB
- spawn claude 时反正还要解码到内存或刷到临时文件，多此一举

**为什么不用 BLOB 类型**：
- better-sqlite3 BLOB 读出来是 Buffer，跨 IPC 时序列化成本高
- 引用计数 + cleanup 跟文件系统级别的 hash 命名一样复杂，但调试更难

### Schema

`nodes` 加一列：

```sql
ALTER TABLE nodes ADD COLUMN attachments_json TEXT;  -- 默认 NULL
```

JSON shape：

```ts
type NodeAttachment = {
  hash: string;          // sha256 hex
  mime: string;          // "image/png" | "image/jpeg" | "image/webp" | "image/gif"
  size: number;          // bytes
  filename: string | null;  // 原文件名（粘贴的话 NULL）
  // 渲染辅助：客户端拿到后用来算宽高，避免每个缩略图都加载完整文件
  width?: number;
  height?: number;
};

// nodes.attachments_json = JSON.stringify(NodeAttachment[]) when non-empty
```

数组顺序 = 用户上传顺序。最多 N 张（见 limits）。

### 上传 API

新增 `app/api/uploads/route.ts`：

- **POST** `/api/uploads` —— 接受单个文件（`multipart/form-data` 或 raw body + `Content-Type` header）
  - 服务端：读 stream → 计算 sha256 → 检查 `~/.trellis/blobs/<hash>.<ext>` 是否存在 → 不存在则写入 → 返回 `{ hash, mime, size, filename, width, height }`
  - 限制：单文件 ≤ 10MB，mime 必须在白名单（`image/png|jpeg|webp|gif`）
  - width/height 通过 `image-size` 包嗅探文件头（轻量，不真解码像素）
  - 服务端不做缩略图（前端用 `<img>` + `object-fit: cover` 渲染，单纯展示用不到子分辨率）

- **GET** `/api/uploads/[hash]` —— 流式回读 blob 给 `<img src>`
  - 校验 hash 格式（hex64） → resolve `~/.trellis/blobs/<hash>.*` → 没找到 404
  - 头：`Content-Type: <mime>` + `Cache-Control: public, max-age=31536000, immutable`（hash 永远不变）

### chat route 改造

`ChatRequestRoot` / `ChatRequestBranch` 加可选 `attachments: NodeAttachment[]`：

```ts
type ChatRequestRoot = {
  kind: "root";
  question: string;
  attachments?: NodeAttachment[];
  // ...existing fields
};
type ChatRequestBranch = {
  kind: "branch";
  parentNodeId: string;
  question: string;
  parentAnchor?: { selectedText: string } | null;
  attachments?: NodeAttachment[];
  // ...
};
```

retry 不带 attachments —— 重试时从 DB `nodes.attachments_json` 读已有的。

服务端：

- root / branch 创建节点时把 `attachments` JSON.stringify 写入 `nodes.attachments_json`
- spawn provider 前从 DB 读节点的 attachments（不是从 request body）→ resolve 成 absolute path 数组传给 `LLMProvider.stream({ attachments })`
- `StreamRequest` 加可选 `attachments?: { path: string; mime: string }[]`

### Provider 改造

**`lib/llm/claude.ts`**：

切换调用方式 —— 不再用 `-p <prompt>`，改用 `--input-format stream-json` + stdin JSONL：

```ts
// 仅当 attachments.length > 0 时切到 stream-json 输入
const useStreamInput = (attachments?.length ?? 0) > 0;

const args = [
  ...(useStreamInput ? ["--input-format", "stream-json"] : ["-p", promptText]),
  "--output-format", "stream-json",
  "--include-partial-messages",
  "--model", opts.model ?? "sonnet",
  "--verbose",
  // ...mode-specific flags
];

const proc = spawn("claude", args, { cwd: spawnCwd, stdio: useStreamInput ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"] });

if (useStreamInput) {
  const userMsg = {
    type: "user",
    message: {
      role: "user",
      content: [
        ...attachments.map(a => ({
          type: "image",
          source: {
            type: "base64",
            media_type: a.mime,
            data: fs.readFileSync(a.path).toString("base64"),
          },
        })),
        { type: "text", text: promptText },
      ],
    },
  };
  proc.stdin.write(JSON.stringify(userMsg) + "\n");
  proc.stdin.end();
}
```

注意 stream-json 输入也支持 `--system-prompt` / `--tools` / `--permission-mode` / `--resume` 等所有现有 flags，所以三档 mode 都能复用。

**`lib/llm/codex.ts`**：

不切换调用方式，往 args 数组里插 `--image <path>` 重复 N 次：

```ts
const imageArgs: string[] = [];
for (const a of attachments ?? []) {
  imageArgs.push("--image", a.path);
}
// 拼到 buildArgs 内部的合适位置（在 prompt 之前）
```

### UI 改造

**`components/AttachmentPreview.tsx`**（新建）：

复用组件，渲染 attachment 数组：
- 横向卡片 row（gap-2, overflow-x-auto），每张 80×80 圆角缩略图（`<img src="/api/uploads/<hash>">`）
- 右上角 ✕ 删除按钮（仅在 input 态下显示，已 done 节点的 attachments 是只读）
- 第 4 张及以后折叠为 `+N` 占位卡，点开横排展开
- 单击缩略图 → lightbox（fixed inset-0 + 大图居中 + ESC/click outside 关）

**`components/QuestionInput.tsx`** + **`components/BranchPopover.tsx`**：

输入态加 paste / drag-drop / 选文件三种入口：

1. **粘贴**：`textarea` 的 `onPaste` 事件 → 遍历 `clipboardData.items` 找 `type.startsWith("image/")` 的 → 走上传流程
2. **拖拽**：在 input 容器上加 `onDragOver` + `onDrop`，drop 时 `dataTransfer.files` 走上传
3. **选文件**：textarea 右下角加个图标按钮 → 触发 `<input type="file" accept="image/*" multiple>`

上传流程（统一）：
- 先在 UI 上 push 一个 `{ status: "uploading", localBlobUrl, filename }` 占位
- 异步 fetch POST `/api/uploads` → 拿到 `NodeAttachment` → 替换占位
- 失败 → 占位标红 + ✕ 移除按钮 + 错误 tooltip
- 提交 question 时 attachments 数组只送已 done 的项

最多 N 张（见 limits）；超过后第 N+1 张选/粘/拽都 disable + 红色提示。

**`components/ChatNode.tsx`** + **`components/NodeFullView.tsx`**：

question 区域上方加 `<AttachmentPreview attachments={node.attachments} readOnly />` —— 已 done 节点的图片只能查看不能编辑。

**移动端**：
- `<input type="file" accept="image/*" capture="environment">` 在 mobile Safari 触发相机/相册二选一弹层
- 拖拽不可用（mobile 无 drag），靠粘贴 + 文件选择就够

### Limits

- 单文件 ≤ 10MB（白名单 png/jpeg/webp/gif）
- 单节点 ≤ 6 张图（claude API 限制 100 张但 prompt cost 飞涨；6 是体感够用的上限）
- 总 base64 入 prompt 后估算 token，UI footer 标 "img × N · 估 X token"（按 PNG ≈ 1500-3000 token / 张 估算，不计费视角）

### Migration

- 新列 `attachments_json TEXT` idempotent ALTER，DEFAULT NULL
- 老节点全部 NULL → `node.attachments = []` → 不影响任何现有逻辑
- 不回填

### 与现有特性的互动

- **Reference 节点**：不支持图片 attachment（reference 本身就是材料；要的话开新 qa 子节点带图）
- **重试**：从 DB 读原 attachments，不再让用户重传
- **选区分叉**：父节点的图不会自动继承到子节点（语义：分叉问的是文字段落，不是父节点的图）。子节点想引用父节点的图，就重粘一下
- **导出**：`lib/export.ts` JSON 导出含 attachment 元数据；Markdown 导出用 `![](attachment:<hash>)` 占位（飞书不会真显示，但保留信息）
- **Token 计算**：图片消耗 claude 算在 input_tokens 里返回，沿用现有四桶统计即可；codex 的 `cached_input_tokens` 推算逻辑不变

## 实施步骤

1. **DB + repo**
   - `lib/server/sqlite.ts`：idempotent ALTER `attachments_json TEXT`
   - `lib/server/repo.ts`：NodeRow + NODE_COLS 加列；ApiNode 加 `attachments: NodeAttachment[]`；rowToNode 解 JSON；`createSessionWithRoot` / `createBranchNode` 接受 attachments 写库
2. **Upload API**
   - `app/api/uploads/route.ts` POST + GET
   - `lib/server/blobs.ts` —— 算 hash / 写 blob / resolve path / list orphans
   - 启动时 reap 函数（简单版：第一阶段不做，等真的磁盘膨胀再说）
3. **Types**
   - `lib/types.ts`：`NodeAttachment` + `ChatNode.attachments`
   - `lib/llm/types.ts`：`StreamRequest.attachments?: { path: string; mime: string }[]`
4. **Provider**
   - claude.ts：分支 stream-json 输入模式
   - codex.ts：插 `--image` flag
   - mock.ts：无 op（pass-through，方便单测 UI）
5. **Chat route**
   - root / branch 收 attachments；retry 从 DB 取
   - 服务端把 hash 数组 → path 数组传给 provider
6. **Store**
   - `streamRoot` / `streamBranch` 收第二个参数 attachments（NodeAttachment[]）
   - ChatRequestBody root/branch 加 attachments
7. **UI**
   - `components/AttachmentPreview.tsx` + lightbox
   - QuestionInput 加 paste/drop/file picker
   - BranchPopover 同步加（branch 也支持图片）
   - ChatNode / NodeFullView 渲染只读 attachments
8. **Docs**
   - README 补 vision 一段
   - progress/README.md tick Stage 15

## 测试用例

- 粘贴一张截图到 QuestionInput → 缩略图出现 + filename "(pasted)" → 提交 → claude 看见图回答
- 拖拽多张图到 QuestionInput → 全部上传后预览 → 提交 → claude 看见全部
- 单张 > 10MB → 上传 4xx → UI 红色错误 + ✕ 移除
- 同一张图二次粘贴 → 后端 `/api/uploads` 看到 hash 已存在不重写文件 → 200 直返
- 单节点超过 6 张 → 第 7 张 disabled + tooltip
- Workspace 模式带图问"分析这张截图的代码"，claude 同时能 vision + Read 本地文件
- Project 模式带图问，claude_session_id 仍 resume，cache 命中正常
- Codex provider 带图 → spawn codex 时 args 含 `--image /path/to/blob`
- 删 session → blob 文件不被立即删（GC 留作 P2）
- 重试带图节点 → 服务端从 DB 读 attachments_json，不要求 client 重传
- mobile：相机拍照 → 立刻上传 → 提交

## 不在 scope

- 视频 / 音频 / PDF / 任意文件附件（PDF 走 Stage 19 文件附件 spec，复用本 stage 的 blob 基础设施）
- 服务端缩略图生成（前端 `<img>` 直接吃原图够用，6 张 × 1MB 不会卡）
- 客户端图片压缩（粘贴的截图通常本来就 PNG ≤ 1MB；拖拽手机相册 4-5MB 的可以接受不压缩）
- 图片标注 / 涂鸦 / 裁剪
- Blob GC（孤儿清理）—— 等磁盘真的鼓起来再做。先标 P2
- 在 reference 节点里挂图片（语义不清；先 No）
- 父节点图片"继承"到选区分叉子节点（明确不做）

## 开放问题

1. **stream-json 输入下 claude `--resume` 是否还工作？** Project 模式第 2 轮起需要 `--resume <id>`，spike 时只测了首轮。需要在实施时再测一次：cat input | claude -p --input-format stream-json --resume <id> 能不能 work。猜测 OK（resume 跟 input format 是独立的 flag），但要验证。
2. **codex `--image <FILE>` 路径权限：** codex `--ephemeral --sandbox read-only` 模式下能不能访问 `~/.trellis/blobs/` 路径？sandbox 通常允许 home 但禁 system；猜测 OK 但需要验证。
3. **mime 嗅探 vs trust client header：** 客户端 `Content-Type` 可以伪造，server 端要不要 magic-byte 嗅探 + 校验？第一版先信客户端 + 限白名单 mime + 大小，攻击面有限（本地工具，单用户）。
4. **claude vision token 估算公式：** Anthropic 官方有 token-per-pixel 公式，先粗略按"1500-3000 token/张"标个范围在 UI footer，等用真实数据回流再校准。
5. **stream-json 第 N 轮的请求形态：** 在 stream-json 模式下，"folded history"是不是要也走 user/assistant 消息序列而非单个 user prompt？现有 `buildPrompt` 把祖先链折成单个文本块。如果走多消息形式，模型可能利用得更好，但要重写 buildPrompt 的逻辑。先保持现状（依然单块文本 + 图片附在最后一条 user 上）；如果未来发现回答质量不行再优化。
