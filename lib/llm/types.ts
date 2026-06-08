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
};

export type StreamEvent =
  | { type: "delta"; text: string }
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

export type StreamRequest = {
  history: ChatMessage[];
  question: string;
  parentAnchor?: { selectedText: string } | null;
  signal?: AbortSignal;
  // project mode: if set, claude resumes this session id; if null, a new
  // one is created and emitted via session_init.
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
};

export interface LLMProvider {
  stream(req: StreamRequest): AsyncGenerator<StreamEvent>;
}
