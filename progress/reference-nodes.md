# Stage 12: 节点类型抽象 + 参考卡片

## 动机

当前问题：
1. **建节点必须从问答开始**。画布上"节点"和"问答"是同一个概念，想挂一段背景文档没地方放。
2. **引用追问只能锚到 AI 回复**。读外部文档时（粘贴的英文段落、飞书文档），用户想"划词问这是什么意思"，但段落不在某个节点的 response 里——无法发起 fork。

根因：节点类型只有一种（问答），创建路径也只有一种（划词分叉）。

## 设计

### 两种节点类型

| Kind | 数据 | 是否发给 LLM | 来源 |
|---|---|---|---|
| `qa` | question + response | 是 | 划词追问、根输入 |
| `reference` | source + content_md | 否（除非被引用） | 粘贴 / URL / 上传 |

共享：位置、连线、可被划词引用、topic_label、token 统计。
差异：reference 没有 question/response，只有原文；不会主动喂给 LLM。

### 节点创建路径解耦

画布右下角加 **"+ 新建"** 浮动按钮，点开两个选项：
- 问答卡片（弹出 QuestionInput-like 输入，等价于现在的根输入）
- 参考卡片（弹出 source picker：粘贴 / URL / 上传文件）

新建的节点位置：当前 viewport 中心 + 小偏移避免叠在已有节点上。无 parent，无连线（"漂浮"）；后续从其上划词追问时，会以它为 parent 创建 qa 子节点，连线建立。

**根输入**（`QuestionInput.tsx`）保持不变——空 session 时仍然是它。已有节点的 session 也可以用 + 入口建独立的"漂浮节点"。

### 参考卡片渲染

**默认折叠**（小卡片，~280×100）：
- 顶部：source 类型 icon（📄 paste / 🔗 URL / 📎 file）+ topic_label（用相同的 haiku 生成机制）
- 中部：来源信息（URL 域名 / 文件名 / "粘贴文本"）+ 字数 / token 估计
- 底部：刷新时间（仅 URL/Feishu 类）+ ⟳ 刷新按钮

**展开**（点开进 NodeFullView，复用现有全屏组件）：渲染 markdown 全文。划词 → 弹出"追问"浮条 → 创建 qa 子节点（流程和现在划 AI 回复完全一致）。

LoD 行为复用 Session 10 的 zoom 阈值——折叠态本身就是"compact 卡"，全宽看可以做更紧凑的"超 compact"（仅 icon + 标题），实施时再判断。

### 数据模型

`nodes` 表加列（idempotent ALTER，照搬 `topic_label` / `claude_session_id` 的写法）：

```sql
ALTER TABLE nodes ADD COLUMN kind TEXT NOT NULL DEFAULT 'qa';
ALTER TABLE nodes ADD COLUMN ref_source_type TEXT;       -- 'paste' | 'url' | 'feishu' | 'file'
ALTER TABLE nodes ADD COLUMN ref_source_uri TEXT;        -- URL / 文件路径 / null（paste）
ALTER TABLE nodes ADD COLUMN ref_content_md TEXT;        -- 抓取/粘贴后的 markdown
ALTER TABLE nodes ADD COLUMN ref_fetched_at INTEGER;     -- ms epoch；paste 类用 created_at
ALTER TABLE nodes ADD COLUMN ref_meta_json TEXT;         -- 字数、原始标题、抓取错误等
```

`question`/`response` 在 reference 节点为空字符串（不要 NULL，避免 schema 分裂）。
`parent_id` / `parent_anchor_text` 在"漂浮"参考节点是 NULL。

`lib/types.ts`：
```ts
export type NodeKind = "qa" | "reference";
export type RefSourceType = "paste" | "url" | "feishu" | "file";

export type ReferencePayload = {
  sourceType: RefSourceType;
  sourceUri: string | null;
  contentMd: string;
  fetchedAt: number;
  meta: { wordCount?: number; title?: string; fetchError?: string };
};

export type ChatNode = {
  // ...existing fields
  kind: NodeKind;
  reference: ReferencePayload | null;  // 仅 kind === "reference" 时非空
};
```

### URL 导入策略

按实施成本和体验稳定性分阶段：

**Phase A（MVP，本 stage 必做）**：
- 粘贴文本 — 直入 `ref_content_md`，无网络抓取
- 普通网页 URL — 服务端 fetch + readability。失败兜底：保存原始 HTML 文本 + `meta.fetchError` 标记

**Phase B（本 stage 后续）**：
- PDF / Word 上传 — 调用全局 `pdf` skill 提取
- 飞书分享链接（公开权限）— 复用本机 `feishu-cli-export` skill

**Phase C（独立 stage）**：
- 飞书 OAuth（私有文档）
- Notion / Google Docs
- YouTube 字幕

### 抓取实现

新增 `app/api/references/route.ts`：
- `POST /api/references` body `{ sessionId, sourceType, sourceUri, pastedText? }` → 节点创建
- 服务端 fetch 网页（`sourceType === "url"`）：用 `@mozilla/readability` + `jsdom`（已是 Next.js 友好的小依赖；若太重换 `metascraper` 或最低限度的正文提取）
- **TODO**：实施前先 spike 一次，比较两个库在常见站点（GitHub、博客、文档站）的提取质量
- 失败处理：返回 `meta.fetchError` 但仍创建节点（用户可看到错误并手动修），不要静默失败

刷新：`POST /api/references/:id/refresh` 重抓 + 更新 `ref_content_md` + `ref_fetched_at`。
对粘贴 / 文件类节点禁用刷新按钮。

### 引用上下文如何喂给 LLM

划词从 reference 节点 fork → 创建 qa 子节点时：
- `parent_anchor_text` 填选中文本（已有机制）
- 上下文构建（`buildHistoryForNode`）：识别父是 reference 节点 → 不再走"父 question + response"的拼接，改成喂 **"以下是用户提供的参考材料片段"** + 选区 + 周围若干句（默认前后 200 字符）作为 system context；不喂整篇全文

**关键约束**：reference 整篇默认不进 LLM 上下文。即使一个 reference 节点被多个 qa 子节点引用，每次只喂被选中的那段。后续如果用户需要"把整篇加进上下文"，做成 qa 节点上的显式按钮（"附带整篇参考"），不做默认。

理由：避免 token 黑洞。一篇 5000 字飞书文档 ≈ 4k token，每次问一句都喂全篇会爆。

## 实施步骤

1. **Migration + 数据层**
   - `lib/server/sqlite.ts`：5 个 idempotent ALTER
   - `lib/server/repo.ts`：`rowToNode` 映射 reference 字段；新增 `createReferenceNode(sessionId, payload)` / `refreshReferenceNode(nodeId, payload)`
   - `lib/types.ts`：`NodeKind` + `ReferencePayload` + `ChatNode.kind`/`reference`
2. **API**
   - `app/api/references/route.ts`：POST 创建（粘贴 / URL）
   - `app/api/references/[id]/refresh/route.ts`：POST 刷新
3. **前端 store**
   - `stores/sessionStore.ts`：`createReference(sourceType, payload)` / `refreshReference(nodeId)` actions
4. **UI**
   - `components/ReferenceCard.tsx` 新增（折叠态）
   - `components/Canvas.tsx`：根据 `node.kind` 路由到 ChatNode / ReferenceCard
   - `components/NodeFullView.tsx`：reference 模式分支（只渲染 ref_content_md，复用划词追问浮条）
   - `components/AddNodeFAB.tsx` 新增（画布右下角浮动按钮 + 类型选择 modal）
   - `components/ReferencePicker.tsx` 新增（粘贴 / URL 输入）
5. **Outline / TreeOverlay**
   - 用 source icon + topic_label 区分参考节点
6. **Context 构建**
   - `lib/server/repo.ts:buildHistoryForNode`：父节点是 reference 时走片段路径

## 测试用例

- 画布右下角点 + → 选参考卡片 → 粘贴一段文本 → 节点出现，topic_label 几秒后到位
- 同上但选 URL → 输入 GitHub README 链接 → 节点显示抓取后正文
- URL 抓取失败（404、付费墙）→ 节点仍创建，显示错误徽章
- 在参考节点全屏视图划词 → 追问 → qa 子节点正确创建，连线到该参考
- qa 子节点流式中观察发给 LLM 的上下文（看 token 计数 + 服务端日志）→ 仅含选区 + 上下文，不含整篇
- 删除参考节点 → 其 qa 子节点保留（已有 anchor_text 兜底，不会丢上下文）；删 session → 级联清理
- 折叠态切换：zoom 跨阈值时与 qa 卡片一起 dagre 重排

## 不在这次 scope

- 飞书 OAuth、Notion、Google Docs、YouTube 字幕（Phase C）
- 反向链接（参考节点显示"被哪些 qa 引用过"）— 用户主动提了一句但说先不做
- "把整篇加入上下文"按钮
- 多个参考节点的聚合分析（"对比这两份文档"）

留作 Stage 13+ 候选。

## 开放问题

1. **节点类型继续扩展时怎么办**：现在两种，未来可能加"笔记/总结"、"对比"、"图片"。当前 `kind` + 几个 ref_ 列的方案在 4-5 种之内还行，超过就该拆表或走 polymorphic 设计。不预设。
2. **跨 session 复用参考节点**：用户可能想在多个 session 引用同一份文档。当前 schema 是 session-scoped，跨 session 复用要么 deduplicate by URL，要么提"全局参考库"概念。先不做，等用户提需求。
3. **参考节点在 cli-multi 模式下的语义**：cli-multi 整树共享一个 claude session，参考节点不喂入意味着它对 claude 完全隐形——但其 qa 子节点的"片段引用"会通过 user prompt 喂进去，等价于"用户每次自己引用了一段"。这个语义是否符合用户预期，实测一次再决定要不要在 cli-multi 下额外把参考全文塞进 prompt。
