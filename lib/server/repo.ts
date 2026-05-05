import "server-only";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { getDB } from "./sqlite";
import type { ChatMessage } from "@/lib/llm";
import type {
  NodeKind,
  RefSourceType,
  ReferenceMeta,
  ReferencePayload,
} from "@/lib/types";

// Wire-format types — what gets sent over HTTP. Mirrors the client-side
// types but the response is always present (no null) and position is omitted.

export type ApiSession = {
  id: string;
  title: string;
  rootNodeId: string;
  createdAt: number;
  updatedAt: number;
};

export type ApiNode = {
  id: string;
  sessionId: string;
  parentId: string | null;
  parentAnchor: { selectedText: string } | null;
  question: string;
  response: string;
  status: "streaming" | "done" | "error";
  errorMessage: string | null;
  siblingIndex: number;
  tokenCount: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
  createdAt: number;
  topicLabel: string | null;
  kind: NodeKind;
  reference: ReferencePayload | null;
  readAt: number | null;
};

type NodeRow = {
  id: string;
  session_id: string;
  parent_id: string | null;
  parent_anchor_text: string | null;
  question: string;
  response: string;
  status: string;
  error_message: string | null;
  sibling_index: number;
  token_input: number;
  token_output: number;
  token_cache_read: number;
  token_cache_creation: number;
  created_at: number;
  topic_label: string | null;
  kind: string | null;
  ref_source_type: string | null;
  ref_source_uri: string | null;
  ref_content_md: string | null;
  ref_fetched_at: number | null;
  ref_meta_json: string | null;
  read_at: number | null;
};

const NODE_COLS = `id, session_id, parent_id, parent_anchor_text, question, response,
       status, error_message, sibling_index, token_input, token_output,
       token_cache_read, token_cache_creation, created_at,
       topic_label, kind, ref_source_type, ref_source_uri, ref_content_md,
       ref_fetched_at, ref_meta_json, read_at`;

type SessionRow = {
  id: string;
  title: string;
  root_node_id: string;
  created_at: number;
  updated_at: number;
};

function rowToNode(r: NodeRow): ApiNode {
  const kind: NodeKind = r.kind === "reference" ? "reference" : "qa";
  let reference: ReferencePayload | null = null;
  if (kind === "reference" && r.ref_source_type) {
    let meta: ReferenceMeta = {};
    if (r.ref_meta_json) {
      try {
        meta = JSON.parse(r.ref_meta_json) as ReferenceMeta;
      } catch {
        meta = {};
      }
    }
    // Legacy rows from before the claude-driven fetcher landed may have
    // ref_source_type values like "feishu" or "file" that are no longer
    // part of RefSourceType. Coerce to "url" + carry the original tag
    // forward as meta.platform so UI icon mapping still works.
    let sourceType: RefSourceType;
    if (r.ref_source_type === "paste") {
      sourceType = "paste";
    } else {
      sourceType = "url";
      if (r.ref_source_type !== "url" && !meta.platform) {
        meta = { ...meta, platform: r.ref_source_type };
      }
    }
    reference = {
      sourceType,
      sourceUri: r.ref_source_uri,
      contentMd: r.ref_content_md ?? "",
      fetchedAt: r.ref_fetched_at ?? r.created_at,
      meta,
    };
  }
  return {
    id: r.id,
    sessionId: r.session_id,
    parentId: r.parent_id,
    parentAnchor: r.parent_anchor_text
      ? { selectedText: r.parent_anchor_text }
      : null,
    question: r.question,
    response: r.response,
    status: r.status as ApiNode["status"],
    errorMessage: r.error_message,
    siblingIndex: r.sibling_index,
    tokenCount: {
      input: r.token_input,
      output: r.token_output,
      cacheRead: r.token_cache_read,
      cacheCreation: r.token_cache_creation,
    },
    createdAt: r.created_at,
    topicLabel: r.topic_label,
    kind,
    reference,
    readAt: r.read_at,
  };
}

function rowToSession(r: SessionRow): ApiSession {
  return {
    id: r.id,
    title: r.title,
    rootNodeId: r.root_node_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listSessions(): ApiSession[] {
  const db = getDB();
  const rows = db
    .prepare(
      "SELECT id, title, root_node_id, created_at, updated_at FROM sessions ORDER BY updated_at DESC",
    )
    .all() as SessionRow[];
  return rows.map(rowToSession);
}

export function getSession(id: string): ApiSession | null {
  const db = getDB();
  const row = db
    .prepare(
      "SELECT id, title, root_node_id, created_at, updated_at FROM sessions WHERE id = ?",
    )
    .get(id) as SessionRow | undefined;
  return row ? rowToSession(row) : null;
}

export function getSessionNodes(sessionId: string): ApiNode[] {
  const db = getDB();
  const rows = db
    .prepare(
      `SELECT ${NODE_COLS} FROM nodes WHERE session_id = ? ORDER BY created_at`,
    )
    .all(sessionId) as NodeRow[];
  return rows.map(rowToNode);
}

export function getNode(id: string): ApiNode | null {
  const db = getDB();
  const row = db
    .prepare(`SELECT ${NODE_COLS} FROM nodes WHERE id = ?`)
    .get(id) as NodeRow | undefined;
  return row ? rowToNode(row) : null;
}

export function deleteSession(id: string): void {
  const db = getDB();
  // Look up bound claude session before DELETE so we can unlink the jsonl
  // afterward. cli-multi sessions may have one; lean/cli-single don't.
  const claudeId = getSessionClaudeId(id);
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  if (claudeId) {
    try {
      fs.unlinkSync(claudeSessionPath(claudeId));
    } catch {
      // jsonl may have been moved/deleted manually — best effort.
    }
  }
}

export function getSessionClaudeId(sessionId: string): string | null {
  const db = getDB();
  const row = db
    .prepare("SELECT claude_session_id FROM sessions WHERE id = ?")
    .get(sessionId) as { claude_session_id: string | null } | undefined;
  return row?.claude_session_id ?? null;
}

export function setSessionClaudeId(sessionId: string, claudeId: string): void {
  const db = getDB();
  db.prepare(
    "UPDATE sessions SET claude_session_id = ? WHERE id = ?",
  ).run(claudeId, sessionId);
}

// User-driven session rename. Bumps updated_at so the picker re-sorts the
// row to the top (intentional: just-renamed sessions are most relevant).
// Returns the updated row, or null if the session id doesn't exist —
// caller surfaces 404.
export function renameSession(
  sessionId: string,
  title: string,
  now: number,
): ApiSession | null {
  const db = getDB();
  const trimmed = title.trim();
  if (!trimmed) return null;
  const result = db
    .prepare(
      "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
    )
    .run(trimmed.slice(0, 200), now, sessionId);
  if (result.changes === 0) return null;
  return getSession(sessionId);
}

export function setNodeTopicLabel(nodeId: string, label: string): void {
  const db = getDB();
  db.prepare("UPDATE nodes SET topic_label = ? WHERE id = ?").run(
    label,
    nodeId,
  );
}

// Mark a node as read. Idempotent — repeated calls don't bump the timestamp.
// Returns the persisted readAt (existing or newly set), or null if the node
// doesn't exist.
export function markNodeRead(nodeId: string, now: number): number | null {
  const db = getDB();
  const existing = db
    .prepare("SELECT read_at FROM nodes WHERE id = ?")
    .get(nodeId) as { read_at: number | null } | undefined;
  if (!existing) return null;
  if (existing.read_at) return existing.read_at;
  db.prepare("UPDATE nodes SET read_at = ? WHERE id = ?").run(now, nodeId);
  return now;
}

// Claude CLI stores session transcripts at
// ~/.claude/projects/<encoded-cwd>/<session_id>.jsonl, where encoded-cwd is
// the absolute cwd path with "/" replaced by "-" (e.g. "/Users/foo" →
// "-Users-foo"). We always spawn cli-multi from os.homedir(), so the encoded
// dir is derived from there.
function claudeSessionPath(sessionId: string): string {
  const encodedCwd = os.homedir().replace(/\//g, "-");
  return path.join(os.homedir(), ".claude", "projects", encodedCwd, `${sessionId}.jsonl`);
}

export function createSessionWithRoot(args: {
  sessionId: string;
  nodeId: string;
  title: string;
  question: string;
  now: number;
}): { session: ApiSession; node: ApiNode } {
  const db = getDB();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO sessions (id, title, root_node_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(args.sessionId, args.title, args.nodeId, args.now, args.now);

    db.prepare(
      `INSERT INTO nodes (id, session_id, parent_id, parent_anchor_text, question, response, status, sibling_index, created_at)
       VALUES (?, ?, NULL, NULL, ?, '', 'streaming', 0, ?)`,
    ).run(args.nodeId, args.sessionId, args.question, args.now);
  });
  tx();
  return {
    session: getSession(args.sessionId)!,
    node: getNode(args.nodeId)!,
  };
}

export function createBranchNode(args: {
  nodeId: string;
  parentId: string;
  question: string;
  parentAnchor: { selectedText: string } | null;
  now: number;
}): ApiNode {
  const db = getDB();
  const parent = db
    .prepare("SELECT session_id FROM nodes WHERE id = ?")
    .get(args.parentId) as { session_id: string } | undefined;
  if (!parent) throw new Error(`parent node ${args.parentId} not found`);

  const siblingCount = db
    .prepare("SELECT COUNT(*) AS n FROM nodes WHERE parent_id = ?")
    .get(args.parentId) as { n: number };

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO nodes (id, session_id, parent_id, parent_anchor_text, question, response, status, sibling_index, created_at)
       VALUES (?, ?, ?, ?, ?, '', 'streaming', ?, ?)`,
    ).run(
      args.nodeId,
      parent.session_id,
      args.parentId,
      args.parentAnchor?.selectedText ?? null,
      args.question,
      siblingCount.n,
      args.now,
    );
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
      args.now,
      parent.session_id,
    );
  });
  tx();
  return getNode(args.nodeId)!;
}

// Wipe response/usage/error and flip status back to streaming. Used by retry
// to reuse the same node row, so the tree shape stays clean. Returns the
// preserved question + anchor so the caller can re-stream against them.
export function resetNodeForRetry(
  nodeId: string,
): { question: string; parentAnchor: { selectedText: string } | null } | null {
  const db = getDB();
  const row = db
    .prepare(
      "SELECT question, parent_anchor_text FROM nodes WHERE id = ?",
    )
    .get(nodeId) as
    | { question: string; parent_anchor_text: string | null }
    | undefined;
  if (!row) return null;
  db.prepare(
    `UPDATE nodes
     SET response = '', status = 'streaming',
         error_message = NULL,
         token_input = 0, token_output = 0,
         token_cache_read = 0, token_cache_creation = 0
     WHERE id = ?`,
  ).run(nodeId);
  return {
    question: row.question,
    parentAnchor: row.parent_anchor_text
      ? { selectedText: row.parent_anchor_text }
      : null,
  };
}

export function appendNodeResponse(nodeId: string, delta: string): void {
  const db = getDB();
  db.prepare("UPDATE nodes SET response = response || ? WHERE id = ?").run(
    delta,
    nodeId,
  );
}

export function finalizeNode(args: {
  nodeId: string;
  status: "done" | "error";
  errorMessage?: string;
  tokenInput: number;
  tokenOutput: number;
  tokenCacheRead: number;
  tokenCacheCreation: number;
  now: number;
}): void {
  const db = getDB();
  const node = db
    .prepare("SELECT session_id FROM nodes WHERE id = ?")
    .get(args.nodeId) as { session_id: string } | undefined;
  if (!node) return;
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE nodes
       SET status = ?, error_message = ?,
           token_input = ?, token_output = ?,
           token_cache_read = ?, token_cache_creation = ?
       WHERE id = ?`,
    ).run(
      args.status,
      args.errorMessage ?? null,
      args.tokenInput,
      args.tokenOutput,
      args.tokenCacheRead,
      args.tokenCacheCreation,
      args.nodeId,
    );
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
      args.now,
      node.session_id,
    );
  });
  tx();
}

// Walk parent chain of a node (excluding the node itself) to build the
// conversation history sent to the LLM. Two compression knobs:
//   - maxDepth: hard cap on ancestors traversed. Defaults to 2 (immediate
//     parent + grandparent) — most thought-tree workflows don't need the
//     entire root-to-here chain repeated every turn.
//   - useAnchorExcerpt: if the new node was branched from a selection
//     (parent_anchor_text), the immediate parent's response is replaced by
//     just the selected excerpt. The user already pointed at what matters;
//     sending the full parent response is wasteful.
//
// Reference parents (kind="reference") are special-cased: we don't fold
// their question/response (both empty by design); instead we synthesize a
// "here is the user-provided source material" message scoped to the
// child's selection plus surrounding context. The full document is never
// sent — see progress/reference-nodes.md for token cost rationale.
export function buildHistoryForNode(
  nodeId: string,
  opts: { maxDepth?: number; useAnchorExcerpt?: boolean } = {},
): ChatMessage[] {
  const maxDepth = opts.maxDepth ?? 2;
  const useAnchorExcerpt = opts.useAnchorExcerpt ?? true;
  const db = getDB();
  const stmt = db.prepare(
    `SELECT id, parent_id, question, response, parent_anchor_text,
            kind, ref_content_md, ref_meta_json
     FROM nodes WHERE id = ?`,
  );
  type Row = {
    id: string;
    parent_id: string | null;
    question: string;
    response: string;
    parent_anchor_text: string | null;
    kind: string | null;
    ref_content_md: string | null;
    ref_meta_json: string | null;
  };
  const self = stmt.get(nodeId) as Row | undefined;
  if (!self) return [];

  // Buffer pushes innermost-first; reversed at the end for chronological order.
  const buffer: ChatMessage[] = [];
  let curId: string | null = self.parent_id;
  let depth = 0;
  let isImmediateParent = true;
  while (curId && depth < maxDepth) {
    const cur = stmt.get(curId) as Row | undefined;
    if (!cur) break;

    if (cur.kind === "reference") {
      // Synthetic context block — only emit for the immediate parent (the
      // common case: qa branched directly off a reference). Deeper ancestors
      // just terminate the walk; closer qa ancestors already supply context.
      if (isImmediateParent && self.parent_anchor_text) {
        buffer.push({
          role: "user",
          content: buildReferenceContextBlock(
            cur.ref_content_md ?? "",
            cur.ref_meta_json,
            self.parent_anchor_text,
          ),
        });
      }
      break;
    }

    let response = cur.response;
    if (
      isImmediateParent &&
      useAnchorExcerpt &&
      self.parent_anchor_text &&
      cur.response
    ) {
      response = `[此处仅保留新节点关注的原文片段]\n\n${self.parent_anchor_text}`;
    }
    if (response) buffer.push({ role: "assistant", content: response });
    buffer.push({ role: "user", content: cur.question });

    curId = cur.parent_id;
    isImmediateParent = false;
    depth++;
  }

  return buffer.reverse();
}

function buildReferenceContextBlock(
  contentMd: string,
  metaJson: string | null,
  anchorText: string,
  padChars = 200,
): string {
  let title = "参考材料";
  if (metaJson) {
    try {
      const m = JSON.parse(metaJson) as { title?: string };
      if (typeof m.title === "string" && m.title.trim()) {
        title = `参考材料《${m.title.trim()}》`;
      }
    } catch {
      /* ignore malformed meta — fall back to generic title */
    }
  }

  let excerpt = anchorText;
  if (contentMd) {
    const idx = contentMd.indexOf(anchorText);
    if (idx !== -1) {
      const start = Math.max(0, idx - padChars);
      const end = Math.min(
        contentMd.length,
        idx + anchorText.length + padChars,
      );
      excerpt = contentMd.slice(start, end);
      if (start > 0) excerpt = "…" + excerpt;
      if (end < contentMd.length) excerpt = excerpt + "…";
    }
  }

  return `以下是用户附带的${title}片段：\n\n${excerpt}\n\n用户从中选中了：「${anchorText}」`;
}

// Create a fresh session whose root node IS the reference itself. Used by
// the empty-state "start from background material" flow. Mirrors
// createSessionWithRoot but writes a kind="reference" row instead of a
// streaming qa one. Title falls back to topicLabel / sourceUri host so the
// session list looks reasonable even when the user didn't supply one.
//
// status defaults to "done" (paste path). For the URL streaming flow,
// pass status="streaming" so the row is visible on the canvas while the
// fetcher runs in the background.
export function createSessionWithReference(args: {
  sessionId: string;
  nodeId: string;
  title: string;
  sourceType: RefSourceType;
  sourceUri: string | null;
  contentMd: string;
  meta: ReferenceMeta;
  topicLabel: string | null;
  status?: "streaming" | "done" | "error";
  now: number;
}): { session: ApiSession; node: ApiNode } {
  const db = getDB();
  const status = args.status ?? "done";
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO sessions (id, title, root_node_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(args.sessionId, args.title, args.nodeId, args.now, args.now);

    db.prepare(
      `INSERT INTO nodes (id, session_id, parent_id, parent_anchor_text,
                          question, response, status, sibling_index, created_at,
                          topic_label, kind, ref_source_type, ref_source_uri,
                          ref_content_md, ref_fetched_at, ref_meta_json)
       VALUES (?, ?, NULL, NULL, '', '', ?, 0, ?,
               ?, 'reference', ?, ?, ?, ?, ?)`,
    ).run(
      args.nodeId,
      args.sessionId,
      status,
      args.now,
      args.topicLabel,
      args.sourceType,
      args.sourceUri,
      args.contentMd,
      args.now,
      JSON.stringify(args.meta),
    );
  });
  tx();
  return {
    session: getSession(args.sessionId)!,
    node: getNode(args.nodeId)!,
  };
}

// Reference (kind="reference") node creation. Floating: parent_id stays
// NULL, sibling_index 0. status defaults to "done" (paste path); pass
// "streaming" to pre-create a placeholder while a URL fetch runs.
// Reference nodes attach to an existing session; callers must supply a
// sessionId that already has a row.
export function createReferenceNode(args: {
  nodeId: string;
  sessionId: string;
  sourceType: RefSourceType;
  sourceUri: string | null;
  contentMd: string;
  meta: ReferenceMeta;
  topicLabel: string | null;
  status?: "streaming" | "done" | "error";
  now: number;
}): ApiNode {
  const db = getDB();
  const status = args.status ?? "done";
  const session = db
    .prepare("SELECT id FROM sessions WHERE id = ?")
    .get(args.sessionId);
  if (!session) throw new Error(`session ${args.sessionId} not found`);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO nodes (id, session_id, parent_id, parent_anchor_text,
                          question, response, status, sibling_index, created_at,
                          topic_label, kind, ref_source_type, ref_source_uri,
                          ref_content_md, ref_fetched_at, ref_meta_json)
       VALUES (?, ?, NULL, NULL, '', '', ?, 0, ?,
               ?, 'reference', ?, ?, ?, ?, ?)`,
    ).run(
      args.nodeId,
      args.sessionId,
      status,
      args.now,
      args.topicLabel,
      args.sourceType,
      args.sourceUri,
      args.contentMd,
      args.now,
      JSON.stringify(args.meta),
    );
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
      args.now,
      args.sessionId,
    );
  });
  tx();
  return getNode(args.nodeId)!;
}

// Final post-fetch update for a reference node: writes content_md, meta,
// fetched_at, optional new topic_label, and flips status (streaming →
// done|error). Used by the URL streaming flow once the claude generator
// emits its result event. Returns the updated node, or null if the row
// vanished.
export function finalizeReferenceFetch(args: {
  nodeId: string;
  contentMd: string;
  meta: ReferenceMeta;
  status: "done" | "error";
  topicLabel?: string | null;
  errorMessage?: string | null;
  now: number;
}): ApiNode | null {
  const db = getDB();
  const row = db
    .prepare("SELECT session_id, kind, topic_label FROM nodes WHERE id = ?")
    .get(args.nodeId) as
    | { session_id: string; kind: string | null; topic_label: string | null }
    | undefined;
  if (!row || row.kind !== "reference") return null;

  // Only overwrite topic_label if caller supplies one and the row's
  // existing label was a placeholder (host fallback). Stable behavior:
  // user-supplied paste titles aren't squashed by a refresh.
  const newLabel =
    args.topicLabel !== undefined && args.topicLabel !== null
      ? args.topicLabel
      : row.topic_label;

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE nodes
       SET ref_content_md = ?, ref_meta_json = ?, ref_fetched_at = ?,
           topic_label = ?, status = ?, error_message = ?
       WHERE id = ?`,
    ).run(
      args.contentMd,
      JSON.stringify(args.meta),
      args.now,
      newLabel,
      args.status,
      args.errorMessage ?? null,
      args.nodeId,
    );
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
      args.now,
      row.session_id,
    );
  });
  tx();
  return getNode(args.nodeId);
}

// Refresh an existing reference node's content (e.g. re-fetch a URL).
// Updates content_md / meta / fetched_at; preserves source_type / source_uri
// / topic_label. Returns null if the node isn't a reference or doesn't exist.
export function refreshReferenceNode(args: {
  nodeId: string;
  contentMd: string;
  meta: ReferenceMeta;
  now: number;
}): ApiNode | null {
  const db = getDB();
  const row = db
    .prepare("SELECT session_id, kind FROM nodes WHERE id = ?")
    .get(args.nodeId) as
    | { session_id: string; kind: string | null }
    | undefined;
  if (!row || row.kind !== "reference") return null;

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE nodes
       SET ref_content_md = ?, ref_meta_json = ?, ref_fetched_at = ?
       WHERE id = ?`,
    ).run(
      args.contentMd,
      JSON.stringify(args.meta),
      args.now,
      args.nodeId,
    );
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
      args.now,
      row.session_id,
    );
  });
  tx();
  return getNode(args.nodeId);
}

// Cleanup leftover streaming nodes — call on server start. If the process
// crashed mid-stream, those nodes get marked as errored.
export function reapInterruptedStreams(): number {
  const db = getDB();
  const result = db
    .prepare(
      `UPDATE nodes SET status = 'error', error_message = 'interrupted' WHERE status = 'streaming'`,
    )
    .run();
  return result.changes;
}
