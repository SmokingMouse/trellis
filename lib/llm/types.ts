export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

// Three context modes (Stage 14, see progress/mode-workspace-rebuild.md):
//   chat        — like a GPT web client. Bare text reply with WebSearch +
//                 WebFetch tool access only. No cwd binding. Replaces 'lean'.
//   workspace   — like a one-shot Claude Code CLI. Full skills + tools +
//                 CLAUDE.md, but each turn stateless (history folded by
//                 trellis, depth=2). Bound to a cwd. Replaces 'cli-single'.
//   project     — like ChatGPT Projects / Claude Projects. Full CLI plus
//                 the entire trellis session shares one claude session_id
//                 (linear turn history). Branches see the same history.
//                 Bound to a cwd. Replaces 'cli-multi'.
//
// Mode is locked at session creation; not switchable mid-tree.
export type Mode = "chat" | "workspace" | "project";

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
    }
  | {
      type: "tool_call_done";
      id: string;
      output: string | null;
      stderr: string | null;
      isError: boolean;
      endedAt: number;
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
  // or workspace/project fallback when path missing).
  cwd?: string | null;
  // Stage 15: image attachments. Each is a resolved on-disk path
  // (provider reads it as needed) plus mime so the right wrapper is
  // emitted. Empty array when none.
  attachments?: { path: string; mime: string }[];
  // D1: chat-mode custom system prompt. null/undefined → provider uses
  // DEFAULT_SYSTEM_PROMPT. Ignored by workspace/project (they use CLAUDE.md).
  systemPrompt?: string | null;
  // chat "enhanced mode": when true, chat gets a scratch workspace + full
  // permission (no sandbox) so it can run skills + the web — YOLO. Default
  // off = pure conversation (claude: WebSearch/WebFetch only; codex: readonly).
  chatEnhanced?: boolean;
  // Permission gate: when true (workspace/project, claude family), the spawn
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
