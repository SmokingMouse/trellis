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
  tokenCount: { input: number; output: number };
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
};

export type Session = {
  id: string;
  title: string;
  rootNodeId: string;
  createdAt: number;
  updatedAt: number;
};
