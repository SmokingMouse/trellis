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

// The three things claude spawns as a background "task". All three announce
// themselves through the *same* system/task_* lines, so `taskType` is the only
// honest way to tell them apart — see the comment on TaskMeta.
export type TaskKind = "local_agent" | "local_bash" | "local_workflow";

// One entry of a workflow's progress snapshot. The CLI emits the whole array
// fresh (not a delta) on `task_progress`, roughly once a second, so replacing
// it wholesale is correct. Two entry shapes observed in the wild; anything
// else the CLI grows later simply fails both `.type` filters and is ignored.
export type WorkflowPhaseEntry = {
  type: "workflow_phase";
  index: number;
  title: string;
};

export type WorkflowAgentEntry = {
  type: "workflow_agent";
  index: number;
  label: string;           // agent()'s `label` opt — the node name in the tree
  phaseIndex?: number;
  phaseTitle?: string;
  agentId?: string;
  model?: string;
  fallbackModel?: string;
  state?: string;          // "start" | "done" | ... (CLI-side, not enumerated)
  queuedAt?: number;
  startedAt?: number;
  lastProgressAt?: number;
  attempt?: number;
  promptPreview?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  resultPreview?: string;
};

export type WorkflowProgressEntry = WorkflowPhaseEntry | WorkflowAgentEntry;

// Metadata for a tool call that spawned a background task. Sourced from
// claude's `system` task_started / task_progress / task_updated /
// task_notification lines (see @sm/agent EventType.Task), which carry live
// progress the tool_use block alone doesn't have. Every field optional: the
// CLI feeds them in across phases (taskType + prompt at start, usage during,
// summary at the end), and old rows / other backends have none of it.
//
// ⚠️ This is NOT "sub-agent metadata", though it was named that until we
// learned better. A slow *foreground* Bash gets the exact same treatment
// (task_type: local_bash) — as does Workflow. Treating "has task meta" as
// "is a sub-agent" is what made command output vanish: the row got claimed
// into a sub-agent group whose report field preferred `summary`, and for a
// local_bash the summary is just the description echoed back.
export type TaskMeta = {
  taskId?: string;
  // Only present on task_started — later phases patch onto the same row, so
  // the merged meta keeps it. Absent = pre-0.3.3 SDK or a non-claude backend;
  // callers fall back to the taskId prefix (a/b/w) then to the tool name.
  taskType?: TaskKind;
  phase?: string;          // "started" | "progress" | "updated" | "completed"
  subagentType?: string;   // "general-purpose" | "Explore" | custom agent name
  description?: string;    // short label; live-updated to the current step
  prompt?: string;         // the full task handed over (the script, for workflows)
  status?: string;         // "completed" | "failed" | ... (from task_updated)
  lastToolName?: string;   // tool the sub-agent is running right now
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
  // The task's final report. Trustworthy for local_agent only — for
  // local_bash it's the description echoed back, and for local_workflow it's
  // 'Dynamic workflow "..." completed'. Never show it in place of output.
  summary?: string;
  outputFile?: string;
  workflowName?: string;   // meta.name from the workflow script
  workflowProgress?: WorkflowProgressEntry[];
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
  // Present when this call spawned a background task — a sub-agent, a
  // long-running Bash, or a Workflow. `agent.taskType` says which; the field
  // name is a historical misnomer kept to avoid a data migration (it is
  // serialized into nodes.tool_calls_json).
  agent?: TaskMeta;
};

// 预计算的工具调用统计——GET /api/sessions/[id] 用它替代完整 toolCalls 数组
// （后者体积能占会话载荷的 98%，改为按需拉取，见 ChatNode.toolCalls 注释）。
// 字段与 countToolTree 的产物对齐；labels 是子 Agent 名（角标 tooltip 用），
// tools 是顶层工具名去重（折叠摘要行在无委派时点名工具，≤5 个，客户端截 4）。
export type ToolCallStats = {
  total: number;
  subagents: number;
  workflows: number;
  errors: number;
  labels: string[];
  tools: string[];
};

// 一轮里被写/改过的文件（GeneratedFilesBar 用）。从 toolCalls 里抽
// Write/Edit/MultiEdit/NotebookEdit 的 file_path 去重而得。
export type GeneratedFile = { absPath: string; name: string };

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
  // Total turn duration in milliseconds (measured from question submission to stream done).
  // null while running or for legacy rows without recorded duration.
  durationMs?: number | null;
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
  //
  // 大会话里这一项能占 /api/sessions/[id] 载荷的 98%（实测 10MB 里 9.9MB），
  // 所以 GET /api/sessions/[id] 不再下发它，改发预计算的 toolCallStats +
  // generatedFiles；完整数组按需走 GET /api/nodes/[id]/tool-calls（展开动线
  // 时才拉）。流式节点不受影响——toolCalls 随流事件进 store。
  toolCalls: ToolCall[];
  // 预计算的工具调用统计（服务端随会话载荷下发）。toolCalls 被懒加载后，
  // 卡片角标 / 动线折叠态靠它渲染，不必等按需拉取。
  toolCallStats?: ToolCallStats | null;
  // 预计算的「本轮生成文件」清单（服务端随会话载荷下发），供
  // GeneratedFilesBar 在 toolCalls 未加载时渲染。
  generatedFiles?: GeneratedFile[];
  // A路②: non-null while this node's run is paused on an interactive tool
  // (AskUserQuestion / ExitPlanMode) waiting for the user to answer. The UI
  // renders the form from this; POST /api/nodes/[id]/respond clears it.
  pendingInteraction: PendingInteraction | null;
  // Agent 长任务的 response 是「过程叙述段 + 最终答复」拼起来的（工具调用/思考
  // 之间模型说的每句话都进了同一个字符串）。这里记录**最后一次结构性中断
  // （thinking / 工具调用）之后的正文起始偏移** —— [0, finalStart) 是过程叙述，
  // [finalStart, ∞) 是最终答复。0/null/缺省 = 整段都是答复（纯 chat、旧数据），
  // UI 不分层。run-bus 流式时实时维护，finalize 落库；cli-import 按块结构精确计算。
  finalStart?: number | null;
  // 树面板雪藏标记：仅树根携带语义（分支节点恒 null）。non-null = 用户手动
  // 隐藏这棵树的时刻；树内新增节点（分叉/重试）自动清空（写即复活）。
  hiddenAt: number | null;
  // S88：这一轮由哪个 Agent 作答。'mention' = @提及的单轮外援（TurnCard 挂 chip）；
  // 'session' = 会话人设（不挂 chip —— 每张卡都挂一枚是噪音，会话级显示在 Header）。
  agentId?: string | null;
  agentScope?: "session" | "mention" | null;
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
  // CLI family owning sourceJsonlPath. null for native sessions.
  cliProvider?: "claude" | "codex" | null;
  // 权限确认：true = project 的可变更工具（Bash/Write/Edit…）逐个
  // 弹权限卡等用户允许/拒绝；false/缺省 = YOLO（现状，含全部存量行）。
  // 创建时锁定，仅 claude 系 project 可开。
  requireApproval?: boolean;
  // S88 会话人设（agents.id）。null/缺省 = 默认 Agent（老路，行为一字不变）。
  // 创建时锁定；**live 引用** —— agent 定义改了老会话跟着变。
  agentId?: string | null;
};

// S117：侧栏「定时任务」分组的骨架行（GET /api/sessions 的 tasks 字段）。
// 行的实体是任务而非会话 —— 会话是懒建的，没跑过的任务也该有固定入口。
export type SidebarTask = {
  id: string;
  name: string;
  homeSessionId: string | null;
  enabled: boolean;
};

// S133：侧栏「最近」分组的骨架（GET /api/recent）。粒度到链：一条链 = 根→叶子
// 的 lineage（线性视图展示的那种），由叶子 tipId 唯一标识；点链落到链尾。
// 纯数据层（归组 / 截断 / 打标签）在 lib/recent.ts，SQL 真源在 repo.listRecentChains。
export type RecentChainStatus =
  | "streaming"
  | "waiting"
  | "unread"
  | "error"
  | "done";

export type RecentChain = {
  tipId: string;
  rootId: string;
  /** 根→链尾的完整节点 id；实时状态按它与 /api/runs 的节点集合求交。 */
  nodeIds: string[];
  /** 链尾标签（topicLabel 优先，否则问题前缀） */
  label: string;
  /** 所在树的标签（根节点同规则）—— 多树会话里链行前缀它 */
  treeLabel: string;
  /** 链长：根→尾的节点数 */
  depth: number;
  /** 链上 max(createdAt, readAt) */
  activityAt: number;
  status: RecentChainStatus;
};

export type RecentSession = {
  id: string;
  title: string;
  mode: string;
  workspacePath: string | null;
  /** 会话内最大的链活动时间（会话仍按它排序） */
  activityAt: number;
  /** 会话内未雪藏的树数；>1 时链行带树名前缀 */
  treeCount: number;
  chains: RecentChain[];
  /** 超出服务端每会话上限、没下发的链数 */
  moreChains: number;
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
