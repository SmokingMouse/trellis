export type NodeStatus = "streaming" | "done" | "error";

// "qa" — original question/answer node. "reference" — passive material
// node (pasted text, fetched URL, etc.) that doesn't go to the LLM unless
// a child qa node is forked off a selection inside it. See progress/
// reference-nodes.md for the rationale.
export type NodeKind = "qa" | "reference";

// "paste" — user-typed/pasted text. "url" — anything fetched from a URL,
// regardless of the underlying platform. Per-platform identity (feishu,
// youtube, github, etc.) lives in meta.platform so trellis itself stays
// platform-agnostic — claude + local skills decide how to fetch.
export type RefSourceType = "paste" | "url";

export type ParentAnchor = {
  selectedText: string;
};

export type ReferenceMeta = {
  wordCount?: number;
  title?: string;
  // Free-form platform tag set by the fetcher (e.g. "feishu", "youtube",
  // "github", "generic"). UI uses it for icon selection. Stays optional
  // so paste-type refs and unidentified URLs can leave it blank.
  platform?: string;
  // Set when URL fetch failed but we still created the node so the user
  // can see what went wrong and decide to retry / paste manually.
  fetchError?: string;
};

export type ReferencePayload = {
  sourceType: RefSourceType;
  // null for paste; URL for url/feishu; file path / blob ref for file.
  sourceUri: string | null;
  contentMd: string;
  fetchedAt: number;
  meta: ReferenceMeta;
};

// Stage 15: image attachment metadata. The actual bytes live at
// ~/.trellis/blobs/<hash>.<ext> on the server (see lib/server/blobs.ts);
// the client renders thumbnails via /api/uploads/<hash>. Hash is the
// sha256 of the file content so duplicate uploads dedupe by storage.
export type NodeAttachment = {
  hash: string;        // sha256 hex (64 chars)
  mime: string;        // image/png | image/jpeg | image/webp | image/gif
  size: number;        // bytes
  filename: string | null; // original filename; null when pasted from clipboard
  width?: number;      // sniffed at upload time so thumbnails can compute aspect
  height?: number;
};

// Stage 17 (tool visualization): one entry per LLM tool invocation
// observed in the stream. Status flips running → done|error when the
// matching tool_result block arrives. input/output stay as raw JSON or
// string blobs — UI decides how to format (JSON pretty-print for
// structured inputs, monospace block + scroll for Bash stdout, etc.).
export type ToolCallStatus = "running" | "done" | "error";

// Stage 22 (subagent visualization): metadata for a Task/Agent tool call —
// the invocation that spawns a sub-agent. Sourced from claude's `system`
// task_started / task_progress / task_updated / task_notification lines
// (see @sm/agent EventType.Task), which carry live progress the tool_use
// block alone doesn't have. Every field optional: the CLI feeds them in
// across phases (prompt at start, usage during, summary at the end), and
// old rows / other backends have none of it.
export type SubagentMeta = {
  taskId?: string;
  subagentType?: string;   // "general-purpose" | "Explore" | custom agent name
  description?: string;    // short label; live-updated to the current step
  prompt?: string;         // the full task handed to the sub-agent
  status?: string;         // "completed" | "failed" | ... (from task_updated)
  lastToolName?: string;   // tool the sub-agent is running right now
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
  summary?: string;        // the sub-agent's final report
  outputFile?: string;
};

export type ToolCall = {
  // The CLI's id (e.g. "toolu_017sqa1c..."). Stable across the start +
  // result events so the UI can merge them.
  id: string;
  name: string;          // "Bash" | "Read" | "Edit" | "WebFetch" | ...
  input: unknown;        // shape varies per tool; pretty-printed as JSON in UI
  // null until the matching tool_result arrives. Often a multi-line
  // string (Bash stdout); UI clamps display.
  output: string | null;
  // Captured separately from `content` for Bash since claude includes
  // both in tool_use_result. UI shows stderr only when non-empty.
  stderr: string | null;
  status: ToolCallStatus;
  // Wall-clock ms from start emit to done emit. null while running.
  durationMs: number | null;
  // Server-side timestamps for ordering + duration computation.
  startedAt: number;
  endedAt: number | null;
  // Stage 22: non-null when this call was made *by a sub-agent* rather than
  // the main agent — it carries the tool_use id of the Task/Agent call that
  // spawned it. Absent/null = main agent (all pre-Stage-22 rows). The UI
  // groups children under their parent instead of one flat chain.
  parentToolUseId?: string | null;
  // Stage 22: present only on the Task/Agent call itself — live progress and
  // final report of the sub-agent it spawned.
  agent?: SubagentMeta;
};

// A路②: a paused interactive-tool prompt awaiting a user answer. Set while
// an AskUserQuestion / ExitPlanMode call is in flight; cleared on response or
// abort. input carries the tool's raw arguments (e.g. AskUserQuestion's
// { questions: [...] }) so the UI can render the form without re-fetching.
export type PendingInteraction = {
  toolUseId: string;
  toolName: string;
  input: unknown;
};

export type ChatNode = {
  id: string;
  sessionId: string;
  parentId: string | null;
  parentAnchor: ParentAnchor | null;
  question: string;
  response: string;
  status: NodeStatus;
  errorMessage: string | null;
  position: { x: number; y: number };
  // Four-bucket token accounting per turn. See lib/llm/types.ts:TokenUsage
  // for semantics — split out so UI can surface cache leverage separately
  // from net input/output cost.
  tokenCount: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    // Main-agent context-window occupancy for this turn (last assistant
    // message). null/absent = backend didn't report → the % gauge falls back
    // to input+cacheRead+cacheCreation. See Header.tsx ctx computation.
    contextTokens?: number | null;
  };
  createdAt: number;
  siblingIndex: number;
  // Short LLM-generated topic for overview rendering. Null until done; falls
  // back to question prefix in the UI when not yet available.
  topicLabel: string | null;
  // Defaults to "qa" for legacy rows without the column populated.
  kind: NodeKind;
  // Non-null only when kind === "reference".
  reference: ReferencePayload | null;
  // null = unread; ms timestamp = first time the user kept the node
  // open >=1s. Drives the unread badge / "X 条未读" counter.
  readAt: number | null;
  // Stage 15: optional image attachments belonging to this node's
  // question. Empty array (not null) when none — keeps consumer code
  // free of nullability checks.
  attachments: NodeAttachment[];
  // Stage 17: LLM tool invocations (Bash/Read/WebFetch/etc.) captured
  // from the provider's stream. Ordered by start time. Empty when the
  // model didn't call any tools (chat mode often, project
  // when the prompt didn't need them).
  toolCalls: ToolCall[];
  // A路②: non-null while this node's run is paused on an interactive tool
  // (AskUserQuestion / ExitPlanMode) waiting for the user to answer. The UI
  // renders the form from this; POST /api/nodes/[id]/respond clears it.
  pendingInteraction: PendingInteraction | null;
  // 树面板雪藏标记：仅树根携带语义（分支节点恒 null）。non-null = 用户手动
  // 隐藏这棵树的时刻；树内新增节点（分叉/重试）自动清空（写即复活）。
  hiddenAt: number | null;
};

// S1：侧栏三级分组的骨架，随 /api/sessions 一起下发（服务端真源在
// lib/server/workspaces.ts，那边有 server-only 不能给客户端 import）。
export type WorkspaceSummary = {
  id: string;
  projectId: string;
  name: string;
  path: string;
  /** main | worktree | plain */
  kind: string;
  gitBranch: string | null;
  /** discovered | worktree-scan | trellis */
  createdBy: string;
  lastUsedAt: number | null;
  sessionCount: number;
};

export type ProjectSummary = {
  id: string;
  name: string;
  clusterKey: string;
  gitRemote: string | null;
  workspaces: WorkspaceSummary[];
};

/**
 * S1 P2：workspace 的实时 git 状态，走 `/api/workspaces/git-status` 单独一路
 * （服务端真源在 lib/server/git-status.ts，那边有 server-only 不能给客户端 import）。
 *
 * 与 `WorkspaceSummary.gitBranch` 的分工：那个是登记时写下的缓存、只在启动时
 * 刷新，运行期切分支看不见；这个是当场问 git 拿的。
 */
export type WorkspaceGitStatus = {
  id: string;
  /** detached HEAD / 非 git → null */
  branch: string | null;
  /** 改动 + 未跟踪的文件数（不含被 .gitignore 忽略的） */
  dirty: number;
  /** 分支已并入主干且工作区干净 —— 可以安全回收 */
  reclaimable: boolean;
};

/**
 * 两个「伪项目」的 cluster key —— 它们不是用户心里的项目，是 project-cluster
 * 为兜住无处安放的 cwd 造出来的档位，其 workspace 那一层恒不携带信息：
 *
 * - `trellis:scratch`：~/.trellis/scratch/* 是 trellis 为无 cwd 的会话现造的
 *   一次性目录，名字（`mellow-lynx-90`）从随机词表拼出，对用户毫无所指。
 * - `trellis:home`：家目录自成一档，其下永远只有一个 workspace，名字就是
 *   家目录的 basename（`smokingmouse`）—— 和项目名「主目录」说的是同一件事。
 *
 * 侧栏据此把这两个项目平铺成两级。真源判定在 lib/server/project-cluster.ts
 * （那边有 node 依赖，不能给客户端 import，所以键提到这里共享）。
 */
export const SCRATCH_CLUSTER_KEY = "trellis:scratch";
export const HOME_CLUSTER_KEY = "trellis:home";

export type Session = {
  id: string;
  title: string;
  rootNodeId: string;
  createdAt: number;
  updatedAt: number;
  // Stage 14: locked at session creation. Kept as string here (rather
  // than the narrower Mode union from lib/llm/types) so this module
  // doesn't pull a server-side dependency; callers narrow at use.
  mode: string;
  // null in chat mode (no cwd binding); absolute path otherwise.
  workspacePath: string | null;
  // S1：归属的 workspace，驱动侧栏三级分组。null = 未归组（chat，或
  // workspacePath 指向的目录已不存在）。**不是 workspacePath 的替代** ——
  // 后者才是 spawn cwd 的真源。
  workspaceId?: string | null;
  // D1: custom system prompt locked at creation (chat mode only).
  // null = use the built-in default.
  systemPrompt: string | null;
  // B2: soft-archive flag. true = hidden from tabs + default lists.
  archived: boolean;
  // Per-session model lock (ProviderId string). null = legacy row → the
  // client falls back to its global default. Set at creation, editable.
  model: string | null;
  // CLI 同步：'native' | 'cli-import'（attach 的本机 CLI 会话，双向绑定）。
  origin?: string;
  // cli-import 的源 jsonl 路径（UI 提示 / detach 用），否则 null。
  sourceJsonlPath?: string | null;
  // 权限确认：true = project 的可变更工具（Bash/Write/Edit…）逐个
  // 弹权限卡等用户允许/拒绝；false/缺省 = YOLO（现状，含全部存量行）。
  // 创建时锁定，仅 claude 系 project 可开。
  requireApproval?: boolean;
};

// Notebook entry: a quoted excerpt the user captured from a node while
// reading. Stays per-session (cascades when the session is deleted).
// sourceNodeId carries the originating node so the UI can navigate back
// + scroll to the matching <mark> on the source's response body.
export type Note = {
  id: string;
  sessionId: string;
  sourceNodeId: string;
  quotedText: string;
  createdAt: number;
};
