# Stage 14: 模式重命名 + Workspace 引入

## 动机

两件事一起做，因为它们都改 session 模型且 UX 互相依赖：

1. **`lean / cli-single / cli-multi` → `chat / workspace / project`**：从"prompt 怎么拼"的技术维度命名改成"用什么 job"的场景维度命名。
2. **引入 session 级 workspace_path**：把"AI 工作目录"做成 session 属性。让 Workspace / Project 模式真正能接管"在仓库里干活"的工作流（替代 Claude Code CLI 的拐点）。

附带一个语义升级：
- **mode 从全局 localStorage 偏好 → per-session DB 列**。当前实现下 Header 切 mode 影响所有 session（包括历史），跟"每条 trellis session 是一次独立探索"的核心模型冲突；切完之后回看旧 session，对话上下文都跟着变。改成 session 创建时锁定，跟 workspace_path 一起锁。

## 设计

### 三档语义最终版

| 模式 | 类比 | cwd | 默认工具 | 跨节点 CLI 记忆 |
|---|---|---|---|---|
| `chat` | GPT 网页客户端 | `~` | `WebSearch,WebFetch` | 无 |
| `workspace` | 一次性的 Claude Code CLI | `session.workspace_path` | 全开（bypassPermissions） | 无 |
| `project` | 持续协作 / Claude Projects | `session.workspace_path` | 全开 | 有（claude_session_id） |

不可中途互转，一棵树一个模式。换语境 = 开新 session。

### 数据模型

`sessions` 加两列（idempotent ALTER，沿用 `claude_session_id` / `topic_label` 的模式）：

```sql
ALTER TABLE sessions ADD COLUMN context_mode TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE sessions ADD COLUMN workspace_path TEXT;
```

迁移策略（启动 migrate 时一次性回填）：

```sql
-- 旧 session 没有 context_mode：用 claude_session_id 是否为空区分
UPDATE sessions
SET context_mode = 'project'
WHERE context_mode = 'chat' AND claude_session_id IS NOT NULL;
-- 其余保持 'chat'（lean 是历史上 default，cli-single 没有 DB 痕迹无法区分，
-- 全归到 chat 是 lossless 默认——用户想用 workspace 模式开新 session 即可）
```

`workspace_path` 一律 NULL（旧 session 在 `~` 跑过，NULL = 用 `~` 兜底）。

不加索引——`context_mode` 不参与查询；`workspace_path` 也不。

### TypeScript 类型

```ts
// lib/llm/types.ts
export type Mode = "chat" | "workspace" | "project";

// lib/types.ts
export type Session = {
  // ...existing
  mode: Mode;                       // 新增，必填
  workspacePath: string | null;     // 新增；chat 模式恒为 null
};
```

`StreamRequest` 加 `cwd?: string`（claude/codex provider 用）。

### Mode 持久化迁移

**当前**：`stores/sessionStore.ts:loadMode()` 从 localStorage `MODE_KEY` 读，所有 session 共享。`setMode` action 写 localStorage + state，每次 chat 请求 body 都带当前 mode。

**重构后**：
- localStorage `MODE_KEY` 语义变成"新 session 创建时的默认 mode"（不是运行时设置）
- session state 增加 `currentSession.mode` / `currentSession.workspacePath`（来自 DB）
- `setMode` action 只在"draft session"（还没创建）阶段有效；session 创建后变成只读
- 顶栏 ModePicker 变成 readonly badge（显示当前 session 的 mode + workspace 简写）
- 真正的 mode 切换入口移到 QuestionInput 旁边（仅"无 active session"或"draft state"时显示）

### WorkspacePicker 组件

新建 `components/WorkspacePicker.tsx`。

**功能**：
- 列出最近用过的 workspace（按 last_used_at 降序）
- 支持 pin（pin 列表存 localStorage `workspace_pins`，最多 10 个）
- 每条显示：📁 短名 + 全路径 + 上次使用相对时间
- "Browse..." 兜底：用 `<input type="file" webkitdirectory>` 获取 directory（浏览器 webkit-only API；fallback 给一个文本输入框直接贴路径）
- 顶部固定 "🏠 Home directory" 选项（对应 `~`）—— Workspace/Project 模式下用户可能就想在 home 跑

**最近列表来源**：
- 新增 `app/api/workspaces/recent/route.ts`：服务端读 `~/.claude/projects/` 目录列表，解析每个目录的 metadata（dir name 是 cwd hash 的 escape 形式，需要还原），按 mtime 排序返回前 20
- 同时从 trellis DB 里查 `SELECT DISTINCT workspace_path FROM sessions WHERE workspace_path IS NOT NULL ORDER BY updated_at DESC LIMIT 20`，合并去重
- 服务端检测每个路径的 `.git` / `package.json` / `Cargo.toml` 抽短名

**短名规则**：
- 有 `.git` → `git config --get remote.origin.url` 取 repo 名；fallback basename
- 有 `package.json` → 取 `name` 字段
- 有 `Cargo.toml` → 取 `[package].name`
- 都没有 → basename of path
- 显示时 ellipsize home 前缀：`/Users/foo/code/bar` → `~/code/bar`

**性能**：服务端响应时机一次性扫完，结果存 sessionStorage cache 5min。Browse 一次性扫一个目录开销 < 50ms，可接受。

### Provider / CLI spawn 改造

`lib/llm/claude.ts`：

```ts
// Before:
cwd: mode === "lean" ? os.tmpdir() : os.homedir()

// After:
const effectiveCwd =
  mode === "chat"
    ? os.homedir()
    : (workspacePath ?? os.homedir());
spawn("claude", args, { cwd: effectiveCwd, ... });
```

`StreamRequest` 拿到 `cwd` 字段（route 层从 session 取 workspace_path 传下来）。

Chat 模式工具配置：
```ts
// claude:
if (mode === "chat") {
  args.push("--no-session-persistence");
  args.push("--tools", "WebSearch,WebFetch");
  args.push("--system-prompt", DEFAULT_SYSTEM_PROMPT);
}
```

`codex.ts` 同样处理，但 Codex 的 tool 限制语义不同——Codex 没有 `WebSearch` 这种独立 tool 概念，而是按 sandbox + plugins 控。需要 spike 一次：
- `chat` 模式：sandbox `read-only` + 不加载 MCP（保持当前 lean 行为，Web 搜索能力对 Codex chat 暂不支持，UI 标注"chat 模式下 Codex 不联网；切 claude 或升级到 workspace"）
- `workspace` / `project`：跟现在 cli-single/cli-multi 行为一致 + cwd 注入

### API 改造

`app/api/chat/route.ts`：

- `VALID_MODES = ["chat", "workspace", "project"]`
- `ChatRequestRoot` 新增字段：
  ```ts
  mode: Mode;
  workspacePath?: string | null;  // chat 模式必为 null；workspace/project 模式必填
  ```
- 校验：`workspace` / `project` 模式必须有 workspace_path，否则 400
- `createSessionWithRoot` 接受 mode + workspace_path 参数写入 sessions
- branch / retry 请求**不再带 mode**——从 `sessions.context_mode` 读
- 服务端从 session 取 mode + workspace_path → 传给 provider

`app/api/sessions/route.ts` GET：列表 response 加 `mode` + `workspacePath` 字段。

新增 `app/api/workspaces/recent/route.ts`（见 WorkspacePicker 一节）。

### UI 改造

**`components/ModePicker.tsx`**：拆成两个组件

1. **`ModeBadge`**（顶栏 readonly 显示，替代当前可点的 picker）
   - 显示当前 session 的 mode + workspace 简写（如 `[Workspace · ~/code/trellis]`）
   - hover 显示完整 tooltip
   - Chat 模式不显示 workspace 部分
   - 没有 active session 时不渲染（draft 阶段在 QuestionInput 那边显示选择器）

2. **`ModePicker`**（draft / 新 session 创建时用）
   - 三个 chip：Chat / Workspace / Project（带 icon + 颜色）
   - 选 Workspace / Project 时**强制**展开 WorkspacePicker（不选 workspace 不能继续）
   - 选 Chat 时 workspace 字段直接清空

**`components/QuestionInput.tsx`**：
- 增加一个 modeBar 在 textarea 上方（仅 draft 状态显示）：
  ```
  [💬 Chat]  [💻 Workspace]  [📋 Project]    ← ModePicker chips
  📁 (选了 Workspace/Project 后显示) ~/code/trellis ▼  ← workspace badge
  ```
- 已有 active session 时 modeBar 不显示（用顶栏 ModeBadge 替代）

**`components/Header.tsx`**：
- 替换 `<ModePicker />` 为 `<ModeBadge />`

**`components/NewQuestionPicker.tsx`**（画布 FAB 上的"新提问"入口）：
- 这个入口语义是"在当前 session 里加一个 root"，所以 mode + workspace 沿用 session 的，不需要选择器
- 不变

**Localstorage keys**：
- `MODE_KEY` 保留，语义改为"新 session 默认 mode"
- 新增 `workspace_pins`：JSON array of `{ path, shortName, pinnedAt }`
- 新增 `workspace_last_used`：`{ path, ts }` 用于 picker 默认值

### Store 改造

`stores/sessionStore.ts`：

State 新增：
```ts
// session 是只读的真相来源（DB 决定）
currentSessionMode: Mode | null;
currentSessionWorkspace: string | null;

// draft 状态（无 active session 时，下一次发问要用啥）
draftMode: Mode;                  // 默认从 localStorage MODE_KEY 读，回退 'chat'
draftWorkspace: string | null;    // localStorage workspace_last_used
```

Actions：
- `setDraftMode(mode)` / `setDraftWorkspace(path)`：更新 draft + 写 localStorage
- 删 `setMode`（不再支持中途切）
- session 切换 / hydrate 时同步 `currentSessionMode` + `currentSessionWorkspace`

`streamRoot(question, opts?)`：
- 如果没有 active session：用 draftMode + draftWorkspace 作为请求 body
- 如果有 active session 且 `attachToCurrentSession=true`：直接用 session 的 mode + workspace（不再从 store mode 读）

`streamBranch` / `retryNode`：完全不传 mode（服务端从 session 读）。

### 创建流程文案

新 session 第一屏（空状态 QuestionInput）：

```
[问点啥...]
─────────────
[💬 Chat] [💻 Workspace] [📋 Project]     [可选: 📁 选工作区]
                                          ⌘↩ 发送
```

- 默认 Chat 选中
- 切到 Workspace / Project 时下方出现 workspace picker，未选则发送按钮禁用
- chip hover tooltip 用现有 ModePicker 的描述文案
- 选完 → ⌘↩ 发送 → 创建 session（mode + workspace 落 DB）→ 顶栏 ModeBadge 接管显示

## 实施步骤

按风险递增、可中途中断的顺序：

1. **DB migration + repo**（无 UI 改动，可单独验）
   - `lib/server/sqlite.ts`：两个 idempotent ALTER + `UPDATE sessions SET context_mode='project' WHERE claude_session_id IS NOT NULL`
   - `lib/server/repo.ts`：`SessionRow` 加字段 / `rowToSession` 加映射 / `createSessionWithRoot` 接受 mode + workspace 参数 / `createRootInSession` 不动（attach 到已有 session）
   - 验：手测 INSERT/SELECT 一条 session，DB 看见正确值
2. **Types 重命名**（全代码 grep-replace，编译验）
   - `Mode` 三个值改名 + Session type 加字段
   - 全代码 `lean` / `cli-single` / `cli-multi` 字面量替换
   - `npm run build` 必须过
3. **Provider cwd 注入**
   - claude / codex 接受 cwd + 应用到 spawn
   - chat 模式 claude `--tools "WebSearch,WebFetch"`
   - codex 的 chat 暂保留 read-only 不加联网（标注 TODO）
4. **API 改造**
   - `/api/chat`：mode + workspace 字段进 root，branch/retry 不带 mode 改从 session 读
   - `/api/sessions`：返回 mode + workspace
   - `/api/workspaces/recent`：新增
5. **Store 改造**
   - 增加 `currentSessionMode` / `currentSessionWorkspace` + `draftMode` / `draftWorkspace`
   - 删 `setMode`，加 `setDraftMode` / `setDraftWorkspace`
   - hydrate / streamRoot 走新字段
6. **UI**
   - `WorkspacePicker.tsx` 新建
   - `ModePicker.tsx` 拆成 `ModeBadge` + `ModePicker`（后者只在 QuestionInput 用）
   - `QuestionInput.tsx` 加 modeBar
   - `Header.tsx` 换组件
7. **README 更新**
   - 三档表 + 模式描述全替换
   - 加 workspace 说明

## 测试用例

- **新装用户首次打开**：QuestionInput 显示 Chat 选中、无 workspace；发送 → session 落 DB `context_mode='chat', workspace_path=NULL`
- **切 Workspace 不选 workspace**：发送按钮禁用
- **切 Project + 选 trellis 仓库**：发送 → DB 落 `context_mode='project', workspace_path='/Users/.../trellis'`；claude 子进程 cwd 是 trellis；创建后续 branch 自动用同样的 mode + cwd
- **历史 session（cli-multi 有 claude_session_id）**：migrate 后 mode='project'，workspace_path=NULL，运行时回退到 `~`；后续 branch 仍能 resume 旧 claude_session_id
- **历史 session（lean / cli-single 无 claude_session_id）**：migrate 后 mode='chat'，行为接近原 lean，但工具集从空变成 `WebSearch,WebFetch`——可接受的行为升级
- **顶栏切 session**：ModeBadge 显示对应 session 的 mode + workspace；不会"带"模式去到别的 session
- **WorkspacePicker**：最近列表包含 trellis 本身（开发用户）+ 其他 Claude Code 跑过的项目；pin / unpin localStorage 持久
- **Chat 模式 claude 联网**：问"今天 SF 天气"，能调 WebSearch
- **Codex chat 模式**：UI 提示"Codex chat 不联网"，行为同当前 codex lean

## 不在 scope

- 节点级 workspace override（一棵树一个 workspace，前面 spec 已锁）
- session 创建后改 mode / workspace 的 UI（不可改是 feature）
- 跨 workspace 的 session 视图分组（等 Stage 16 全局搜索时再加 facet）
- Codex chat 模式的联网能力（codex 暂无对应 tool 概念，留个 TODO）
- "我没装 git 就不出短名"的复杂回退（basename 兜底够）
- 多个 trellis 实例同时读 `~/.claude/projects/` 的并发安全（单用户工具，先不管）

## 开放问题

1. **workspace_path 是否做存在性校验？** session 创建时 `fs.existsSync` 检查路径，不存在直接 400。但 session 创建后用户搬了项目目录怎么办——CLI spawn 失败时 graceful 报错（节点 status=error + message="workspace 路径不存在"），不静默回退到 home。
2. **`~/.claude/projects/` 目录扫描的反向映射**：cwd hash 算法已知（claude CLI 自己定义），需要 spike 一次确认我们能从 dir name 还原 cwd。如果还原不可靠 → 扫描时进每个 dir 看是否有 jsonl 文件，取最早 jsonl 的 metadata（jsonl 里有 cwd 字段）。
3. **draft mode 跟创建首次 session 的关系**：第一次打开 app 没有任何 session 时，QuestionInput 显示 mode picker。后续每次打开如果存在 session 默认选中最近的，不显示 picker——但用户想新建呢？现状有 SessionPicker 里的"+ New"按钮，新建走"清空 active session"路径，draft state 接管，picker 重新显示。需要确认这个路径 work。
4. **存量 cli-single session 错归到 chat**：migrate 把 cli-single 全归到 chat。如果用户之前依赖 cli-single 跑 Bash 命令，迁后 chat 没工具会"突然不工作"。提示策略：第一次打开 app 弹一次 toast 说明迁移规则 + 提供"批量改为 Workspace 模式"链接。优先级 P2，先做也行不做也行。
