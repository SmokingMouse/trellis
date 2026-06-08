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
  // model didn't call any tools (chat mode often, workspace/project
  // when the prompt didn't need them).
  toolCalls: ToolCall[];
};

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
  // D1: custom system prompt locked at creation (chat mode only).
  // null = use the built-in default.
  systemPrompt: string | null;
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
