// Claude Code hook 接收端的数据模型。
//
// 这一层刻意不 import 任何 server-only 模块 —— sqlite.ts 要 import 建表 SQL
// （同 LARK_THREAD_TABLES_SQL 的做法），而归一化逻辑要能在纯单测里跑。

/**
 * 一个会话此刻的状态。
 *   working  正在干活（跑工具 / 生成中）
 *   waiting  停下来等人（AskUserQuestion 选择卡 / 权限审批卡）
 *   blocked  被外部条件卡住（当前 claude 的 hook 事件集里没有来源，留给别的 agent）
 *   done     这一轮结束了（Stop）或会话已终止（SessionEnd）
 */
export type HookState = "working" | "blocked" | "waiting" | "done";

/** 权限审批卡。PermissionRequest 归一化出来的 interactivePrompt 形状。 */
export type ApprovalPrompt = {
  approval: { tool: string; summary: string };
};

/** 被子 agent 的 waiting 顶掉之前，父会话的现场。SubagentStop 时用它复位。 */
export type StashedState = {
  state: HookState;
  toolName: string | null;
  toolInput: unknown;
  interactivePrompt: unknown;
};

/** 按 session_id 一条。 */
export type AgentHookRecord = {
  sessionId: string;
  agent: "claude";
  state: HookState;
  prompt: string | null;
  toolName: string | null;
  toolInput: unknown;
  /** 需要人来点的卡片：AskUserQuestion 的 tool_input 原样，或 ApprovalPrompt。 */
  interactivePrompt: unknown;
  lastAssistantMessage: string | null;
  transcriptPath: string | null;
  cwd: string | null;
  paneKey: string | null;
  /** 在跑的子 agent 名单（同名可并行，所以是数组不是集合）。 */
  subagents: string[];
  stashed: StashedState | null;
  updatedAt: number;
  /** 进入当前 state 的时刻。state 不变的事件不刷新它 —— 「卡了多久」靠它算。 */
  stateStartedAt: number;
};

/**
 * Claude Code 喂给 hook 的 JSON。字段全是可选 —— 不同事件给的键不一样，
 * 且 CLI 版本会加字段，这里只认我们用得上的那些。
 */
export type ClaudeHookPayload = {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  prompt?: string;
  last_assistant_message?: string;
  // PermissionRequest 的说明文字（不同版本给的键不一样，都试）
  summary?: string;
  message?: string;
  reason?: string;
  // Subagent* 的子 agent 名（同上，多个候选键）
  subagent_name?: string;
  subagent_type?: string;
  agent_name?: string;
  agent_type?: string;
  [key: string]: unknown;
};

export const AGENT_HOOK_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS agent_hook_state (
    session_id TEXT PRIMARY KEY,
    agent TEXT NOT NULL DEFAULT 'claude',
    state TEXT NOT NULL,
    prompt TEXT,
    tool_name TEXT,
    tool_input TEXT,
    interactive_prompt TEXT,
    last_assistant_message TEXT,
    transcript_path TEXT,
    cwd TEXT,
    pane_key TEXT,
    subagents TEXT NOT NULL DEFAULT '[]',
    stashed TEXT,
    updated_at INTEGER NOT NULL,
    state_started_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS agent_hook_state_updated ON agent_hook_state(updated_at);
`;
