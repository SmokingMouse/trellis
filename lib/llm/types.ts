export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

// Three context modes (see CliModeToggle / store):
//   lean        — bare text reply, no skills/CLAUDE.md/tools
//   cli-single  — full CLI (skills + tools + CLAUDE.md), but each turn is
//                 stateless: history is folded into a single user prompt
//                 (depth=2, anchor compression). Branches stay isolated.
//   cli-multi   — full CLI, plus the entire trellis session shares one claude
//                 session_id (linear turn history). Branches see the same
//                 history — the tree is UI-only. 1 jsonl file per trellis
//                 session, cleaned up on session delete.
export type Mode = "lean" | "cli-single" | "cli-multi";

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; usage?: { input: number; output: number } }
  | { type: "error"; message: string }
  // cli-multi only: emitted once per spawn after parsing system/init.
  // The route handler writes this back to sessions.claude_session_id.
  | { type: "session_init"; sessionId: string };

export type StreamRequest = {
  history: ChatMessage[];
  question: string;
  parentAnchor?: { selectedText: string } | null;
  signal?: AbortSignal;
  // cli-multi: if set, claude resumes this session id; if null, a new one
  // is created and emitted via session_init.
  claudeSessionId?: string | null;
};

export interface LLMProvider {
  stream(req: StreamRequest): AsyncGenerator<StreamEvent>;
}
