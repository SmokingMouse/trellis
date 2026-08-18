import type { TaskMeta } from "@/lib/types";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

// Two context modes (Stage 14 introduced chat/project; the
// workspace tier was retired 2026-07-16 — zero usage, and its two jobs were
// already covered: ad-hoc tools by enhanced chat, repo work by project):
//   chat        — like a GPT web client. Bare text reply with WebSearch +
//                 WebFetch tool access only. No cwd binding. The enhanced
//                 toggle upgrades it to full tools in a scratch workspace.
//   project     — like ChatGPT Projects / Claude Projects. Full CLI; one
//                 lineage per branch (fork = prefix jsonl into a new claude
//                 session). Bound to a cwd.
//
// Mode is locked at session creation; not switchable mid-tree.
export type Mode = "chat" | "project";

// Per-turn token accounting. We track four buckets so the UI can show
// "actual cost" (input + output) separately from "cache leverage"
// (cacheRead, often dominant in project mode where the trellis tree shares
// one CLI session). cacheCreation is the first-write penalty when the
// CLI persists a new prompt prefix; usually small after the first turn.
export type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  // 主 agent「当前上下文窗口实际占用」(末条 assistant 的 input+cache)，区别于
  // 上面四桶的跨迭代累计(含同模型 subagent)。专供算 context 占用%，null/缺省 =
  // 后端没报(codex 老数据/非 claude)，消费端回退到旧的累计口径。
  contextTokens?: number | null;
};

export type StreamEvent =
  | { type: "delta"; text: string }
  // Extended thinking chunk. claude 2.x emits a thinking block BEFORE the
  // text block by default (much longer under high effort), so without this
  // the UI is blind — nothing renders — for the entire思考期. Ephemeral:
  // never persisted, dropped when the turn finalizes (与 CLI 行为一致).
  | { type: "thinking"; text: string }
  | { type: "done"; usage?: TokenUsage }
  | { type: "error"; message: string }
  // project mode only: emitted once per spawn after parsing system/init.
  // The route handler writes this back to sessions.claude_session_id.
  | { type: "session_init"; sessionId: string }
  // Stage 17: tool invocations from claude's stream-json. Started when
  // we see a tool_use content block; done when the matching tool_result
  // arrives. UI shows them as a folded panel above the response text.
  | {
      type: "tool_call_start";
      id: string;
      name: string;
      input: unknown;
      startedAt: number;
      // Stage 22: set when a sub-agent (not the main agent) made this call.
      parentToolUseId?: string | null;
    }
  | {
      type: "tool_call_done";
      id: string;
      output: string | null;
      stderr: string | null;
      isError: boolean;
      endedAt: number;
    }
  // Stage 22: patch的语义 —— 子 agent 的进度/报告分多个 phase 陆续到达，每次只
  // 带自己那几个字段，消费端浅合并进对应 tool call 的 agent。不复用 start（双层
  // 按 id 去重会吞掉重发）也不复用 done（done 置终态，而最终报告先于真正的
  // tool_result 到达，混用会提前终结那条调用）。
  | {
      type: "tool_call_update";
      id: string;
      agent: TaskMeta;
    };

// S88: 一次 spawn 要用的 Agent，已由 lib/server/agent-pack.ts 物化完毕。
// 「定义」（DB 里的 AgentRecord）与「怎么喂给 CLI」（这个类型）刻意分开：
// route 负责查库 + 物化，sdk-adapter 只做纯翻译、不碰 IO。
export type AgentSpawn = {
  /** Provider-specific translation chosen before entering the pure SDK adapter. */
  runtime: "claude" | "codex";
  /** claude --agent 的值，也是 pack 里 agents/<slug>.md 的文件名 */
  slug: string;
  /** 无技能的 agent 走内联 JSON（零 fs 操作）；有技能的走物化好的 pluginDir。二选一。 */
  agentsJson?: string;
  pluginDir?: string;
  /** true = 读本机 CLAUDE.md / settings / skill / MCP；false = 隔离（三者全无） */
  inheritEnv: boolean;
  model?: string | null;
  tools?: string[] | null;
  disallowedTools?: string[] | null;
  permission?: "full" | "default" | "readonly" | "auto-edit" | null;
  requireApproval?: boolean | null;
  /** Codex has no --agent; its persona and selected skill instructions are inlined. */
  systemPrompt?: string;
  /** Snapshot needed to make Codex's environmentSkills=false isolation explicit. */
  environmentSkillNames?: string[];
};

// A路②: interaction_required / interaction_resolved are NOT provider stream
// events — interactive tools flow through the onCanUseTool callback, and
// run-bus synthesizes those two events onto its own bus + SSE wire. They live
// on run-bus's RunEvent and the client store's StreamEvent, never here.

// Decision returned for an interactive tool. Mirrors the SDK's onCanUseTool
// resolution: allow lets the tool run (optionally with rewritten input),
// deny rejects it with an optional message.
export type InteractionDecision = {
  behavior: "allow" | "deny";
  updatedInput?: unknown;
  message?: string;
};

export type StreamRequest = {
  history: ChatMessage[];
  question: string;
  parentAnchor?: { selectedText: string } | null;
  signal?: AbortSignal;
  // project mode: the current provider's resume id (field name is legacy;
  // post family-isolation this is whichever family's id — claude or codex —
  // matches the active provider). If set, the CLI resumes this session id;
  // if null, a new one is created and emitted via session_init. Resume ids
  // are family-scoped — never pass a codex id to claude or vice versa; the
  // route reads it from the family-correct column.
  claudeSessionId?: string | null;
  // Stage 14: cwd to spawn the CLI in. null = home dir (chat default,
  // or project fallback when path missing).
  cwd?: string | null;
  // Stage 15: image attachments. Each is a resolved on-disk path
  // (provider reads it as needed) plus mime so the right wrapper is
  // emitted. Empty array when none.
  attachments?: { path: string; mime: string }[];
  // D1: chat-mode custom system prompt. null/undefined → provider uses
  // DEFAULT_SYSTEM_PROMPT. Ignored by project (it uses CLAUDE.md).
  systemPrompt?: string | null;
  // S88: 本轮由哪个自定义 Agent 作答。由 route 从 sessions.agent_id（会话人设）
  // 或 @提及解析、物化后传入；null/undefined = 默认 Agent，执行链走今天的老路。
  // Claude agent 与 systemPrompt 互斥；Codex agent is translated into systemPrompt.
  agent?: AgentSpawn | null;
  // S88 @提及：这次 spawn 是一次性的 —— 不落盘、不 resume、不 fork。
  // 与 agent 正交：agent 管「谁答」，这个管「这次身份是不是临时的」。
  // 刻意不塞进 applyAgent —— 那一层的铁律是绝不碰上下文与身份。
  ephemeral?: boolean;
  // S88：透传给 SDK 的 extraArgs 逃生舱（当前只用于任务的 --max-budget-usd）。
  // 只允许从结构化配置派生，绝不接用户自由文本 —— 否则可从后门塞
  // --dangerously-skip-permissions 绕过审批闸。
  extraArgs?: string[];
  // chat "enhanced mode": when true, chat gets a scratch workspace + full
  // permission (no sandbox) so it can run skills + the web — YOLO. Default
  // off = pure conversation (Claude: WebSearch/WebFetch only; Codex:
  // readonly + native cached web search, environment config isolated).
  chatEnhanced?: boolean;
  // Permission gate: when true (project, claude family), the spawn
  // uses --permission-mode default + injected ask rules so mutating tools
  // (Bash/Write/Edit/…) pause on can_use_tool and wait for the user's
  // allow/deny (permission card). Only honored when onCanUseTool is present
  // (codex/mock have no stdio protocol → they keep their current policy).
  requireApproval?: boolean;
  // chat B-fork: when true (claude family only), the provider persists + resumes
  // the parent node's forked CLI session (--fork-session) so history lives as
  // immutable message blocks the CLI caches — instead of folding it into the
  // prompt string. claudeSessionId carries the parent's resume id (null on the
  // first turn → fresh session, no fork). codex/mock leave this false and stay
  // on the folded-history path. Set by the route for chat + claude.
  forkSession?: boolean;
  // A路②: bidirectional interaction callback. When set, the claude provider
  // opens the SDK's stdio permission protocol so AskUserQuestion / ExitPlanMode
  // pause and await a user decision. Non-interactive tools are auto-allowed by
  // the caller's dispatcher (run-bus), so passing this never blocks normal
  // tools. codex/mock ignore it (no such protocol). The shape matches the
  // SDK's RunOptions.onCanUseTool exactly.
  onCanUseTool?: (req: {
    toolName: string;
    toolUseId: string;
    requestId: string;
    input: unknown;
  }) => Promise<{
    behavior: "allow" | "deny";
    updatedInput?: unknown;
    message?: string;
  }>;
};

export interface LLMProvider {
  stream(req: StreamRequest): AsyncGenerator<StreamEvent>;
}
