import "server-only";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Database } from "bun:sqlite";
import { getDB } from "./sqlite";
import { codexRolloutExists, deleteCodexRollout } from "./codex-fork";
import { ensureWorkspaceForPath, touchWorkspace } from "./workspaces";
import type { ChatMessage, ProviderFamily, Mode } from "@/lib/llm";
import { sessionCwd } from "@/lib/paths";
import type { RecentChainRow } from "@/lib/recent";
import {
  BOOKMARK_QUESTION_LIMIT,
  BOOKMARK_RESPONSE_LIMIT,
  bookmarkSummary,
} from "@/lib/bookmarks";
import type {
  Bookmark,
  NodeKind,
  NodeAttachment,
  RefSourceType,
  ReferenceMeta,
  ReferencePayload,
  ToolCall,
  TaskMeta,
  PendingInteraction,
} from "@/lib/types";

// Wire-format types — what gets sent over HTTP. Mirrors the client-side
// types but the response is always present (no null) and position is omitted.

export type ApiSession = {
  id: string;
  title: string;
  rootNodeId: string;
  createdAt: number;
  updatedAt: number;
  // Stage 14: locked at session creation. Mode values are
  // 'chat' | 'workspace' | 'project'. The type stays widened to string
  // here while consumers migrate; the llm-layer Mode union narrows it
  // at the boundary.
  mode: string;
  // null in 'chat' mode (no cwd binding); absolute path otherwise.
  workspacePath: string | null;
  // S1：归属的 workspace（侧栏三级分组用）。**不是 workspacePath 的替代** ——
  // 后者才是 spawn cwd 的真源。null = 未归组（chat、或目录已不存在归不了类）。
  workspaceId: string | null;
  // D1: custom system prompt locked at creation (chat mode only).
  // null = use DEFAULT_SYSTEM_PROMPT.
  systemPrompt: string | null;
  // B2: soft-archive flag. true = hidden from tabs + default lists, fully
  // reversible (jsonl/nodes untouched). false = active.
  archived: boolean;
  // Per-session model lock (ProviderId string). null = legacy row → caller
  // falls back to DEFAULT_PROVIDER. Set at creation; editable via PATCH.
  model: string | null;
  // CLI 同步（progress/cli-sync.md）。origin: 'native'（trellis 原生）|
  // 'cli-import'（attach 的本机 CLI 会话，双向绑定，只读 detach 安全）。
  // sourceJsonlPath: cli-import 时的源 jsonl 绝对路径，否则 null。
  origin: string;
  sourceJsonlPath: string | null;
  cliProvider: "claude" | "codex" | null;
  // 权限确认：true = project 轮次的可变更工具需用户逐个允许/拒绝
  // （权限卡）。创建时锁定；false = YOLO（默认，含全部存量行）。
  requireApproval: boolean;
  // S88：会话人设。null = 默认 Agent（执行链走今天的老路，一行不变）。
  // 创建时锁定，与 mode/workspace/systemPrompt 同纪律。**live 引用**：agent 定义
  // 被改了老会话跟着变（用户改 agent 的动机就是「上次答得不好，改了再问」），
  // 想知道当时是谁答的看 nodes.agent_id。
  agentId: string | null;
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
    // Main-agent context occupancy (last assistant message). null = backend
    // didn't report → consumers fall back to the input+cache sum.
    contextTokens?: number | null;
  };
  createdAt: number;
  durationMs: number | null;
  topicLabel: string | null;
  kind: NodeKind;
  reference: ReferencePayload | null;
  readAt: number | null;
  bookmarkedAt: number | null;
  attachments: NodeAttachment[];
  toolCalls: ToolCall[];
  // A路②: non-null while a run paused on an interactive tool awaits the user.
  pendingInteraction: PendingInteraction | null;
  // response 分层偏移（见 lib/types.ts:ChatNode.finalStart）。null/0 = 不分层。
  finalStart: number | null;
  // 树面板雪藏标记。仅根节点携带语义（分支节点恒 null）；non-null = 这棵树被
  // 用户手动隐藏的时刻。树内新增节点时自动清空（写即复活）。
  hiddenAt: number | null;
  // S88：这一轮由哪个 Agent 作答。'mention' = @提及的单轮外援（UI 挂 chip）；
  // 'session' = 会话人设（不挂 chip，否则每张卡都有一枚是噪音）。
  agentId: string | null;
  agentScope: "session" | "mention" | null;
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
  token_context: number | null;
  created_at: number;
  duration_ms: number | null;
  topic_label: string | null;
  kind: string | null;
  ref_source_type: string | null;
  ref_source_uri: string | null;
  ref_content_md: string | null;
  ref_fetched_at: number | null;
  ref_meta_json: string | null;
  read_at: number | null;
  bookmarked_at: number | null;
  attachments_json: string | null;
  tool_calls_json: string | null;
  pending_interaction_json: string | null;
  final_start: number | null;
  hidden_at: number | null;
  agent_id: string | null;
  agent_scope: string | null;
};

const NODE_COLS = `id, session_id, parent_id, parent_anchor_text, question, response,
       status, error_message, sibling_index, token_input, token_output,
       token_cache_read, token_cache_creation, token_context, created_at, duration_ms,
       topic_label, kind, ref_source_type, ref_source_uri, ref_content_md,
       ref_fetched_at, ref_meta_json, read_at, bookmarked_at, attachments_json, tool_calls_json,
       pending_interaction_json, final_start, hidden_at, agent_id, agent_scope`;

type SessionRow = {
  id: string;
  title: string;
  root_node_id: string;
  created_at: number;
  updated_at: number;
  context_mode: string;
  workspace_path: string | null;
  workspace_id: string | null;
  system_prompt: string | null;
  archived: number;
  model: string | null;
  origin: string;
  source_jsonl_path: string | null;
  cli_provider: "claude" | "codex" | null;
  require_approval: number;
  agent_id: string | null;
};

const SESSION_COLS = `id, title, root_node_id, created_at, updated_at,
       context_mode, workspace_path, workspace_id, system_prompt, archived, model,
       origin, source_jsonl_path, cli_provider, require_approval, agent_id`;

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
  let attachments: NodeAttachment[] = [];
  if (r.attachments_json) {
    try {
      const parsed = JSON.parse(r.attachments_json);
      if (Array.isArray(parsed)) attachments = parsed as NodeAttachment[];
    } catch {
      // Malformed JSON — treat as empty rather than crash. Logged once
      // upstream if it ever happens.
    }
  }
  let toolCalls: ToolCall[] = [];
  if (r.tool_calls_json) {
    try {
      const parsed = JSON.parse(r.tool_calls_json);
      if (Array.isArray(parsed)) toolCalls = parsed as ToolCall[];
    } catch {
      /* malformed → empty */
    }
  }
  let pendingInteraction: PendingInteraction | null = null;
  if (r.pending_interaction_json) {
    try {
      const parsed = JSON.parse(r.pending_interaction_json);
      if (parsed && typeof parsed === "object" && "toolUseId" in parsed) {
        pendingInteraction = parsed as PendingInteraction;
      }
    } catch {
      /* malformed → null */
    }
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
      contextTokens: r.token_context,
    },
    createdAt: r.created_at,
    durationMs: r.duration_ms ?? null,
    topicLabel: r.topic_label,
    kind,
    reference,
    readAt: r.read_at,
    bookmarkedAt: r.bookmarked_at,
    attachments,
    toolCalls,
    pendingInteraction,
    finalStart: r.final_start,
    hiddenAt: r.hidden_at,
    agentId: r.agent_id,
    agentScope: r.agent_scope === "mention" ? "mention" : r.agent_scope === "session" ? "session" : null,
  };
}

// S1：路径 → workspace id，永不抛。归组是分组视图的锦上添花，任何失败
// （目录消失 / git 不可用 / 权限）都只该让 session 落到「未归组」，
// 而不是把创建会话这条主链路带崩。
function resolveWorkspaceId(absPath: string): string | null {
  try {
    const id = ensureWorkspaceForPath(absPath);
    if (id) touchWorkspace(id);
    return id;
  } catch (e) {
    console.warn(`[trellis] workspace resolve failed for ${absPath}:`, e);
    return null;
  }
}

function rowToSession(r: SessionRow): ApiSession {
  return {
    id: r.id,
    title: r.title,
    rootNodeId: r.root_node_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    mode: r.context_mode,
    workspacePath: r.workspace_path,
    workspaceId: r.workspace_id,
    systemPrompt: r.system_prompt,
    archived: r.archived === 1,
    model: r.model,
    origin: r.origin ?? "native",
    sourceJsonlPath: r.source_jsonl_path,
    cliProvider: r.cli_provider,
    requireApproval: r.require_approval === 1,
    agentId: r.agent_id,
  };
}

// ---------------------------------------------------------------------------
// Stage 16: FTS5 sync helpers. Internal to repo — every public mutation that
// touches indexable text calls one of these. We do NOT use SQL triggers so
// that streaming deltas (high-frequency `appendNodeResponse`) skip the
// inverted-index churn entirely. See progress/fts-search.md for the
// per-mutation matrix.
// ---------------------------------------------------------------------------

type FtsKind = "node_question" | "node_response" | "node_reference" | "note";

function ftsUpsert(
  db: Database,
  kind: FtsKind,
  sourceId: string,
  sessionId: string,
  text: string,
): void {
  db.prepare(
    "DELETE FROM search_index WHERE source_id = ? AND source_kind = ?",
  ).run(sourceId, kind);
  if (text && text.length > 0) {
    db.prepare(
      `INSERT INTO search_index (text, source_kind, source_id, session_id)
       VALUES (?, ?, ?, ?)`,
    ).run(text, kind, sourceId, sessionId);
  }
}

function ftsDeleteByIds(
  db: Database,
  sourceIds: string[],
): void {
  if (sourceIds.length === 0) return;
  const placeholders = sourceIds.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM search_index WHERE source_id IN (${placeholders})`,
  ).run(...sourceIds);
}

function ftsDeleteBySession(
  db: Database,
  sessionId: string,
): void {
  db.prepare("DELETE FROM search_index WHERE session_id = ?").run(sessionId);
}

// B2: default returns only active (archived=0) sessions — so the tab bar
// and pickers hide archived ones automatically. Pass { archived: true } to
// list ONLY the archived ones (the "show archived" picker view).
export function listSessions(opts?: { archived?: boolean }): ApiSession[] {
  const db = getDB();
  const want = opts?.archived ? 1 : 0;
  const rows = db
    .prepare(
      // S88: kind='task' 是自动化任务的常驻会话，不挤进用户的**活跃**列表；
      // kind='lark' 则必须与 user 一起展示——飞书只是入口，树才是对话本体。
      // —— 它们在侧栏有自己的「定时任务」分组（S117，listTaskSessions）。
      // 归档视图放宽 kind：归档的任务会话若也被排除，就从每个列表里都消失了。
      `SELECT ${SESSION_COLS} FROM sessions
       WHERE archived = ? AND (kind IN ('user', 'lark') OR (? = 1 AND kind = 'task'))
       ORDER BY updated_at DESC`,
    )
    .all(want, want) as SessionRow[];
  return rows.map(rowToSession);
}

// S117: 任务的常驻会话（kind='task'）。不混进 listSessions —— 它们在侧栏有
// 自己的「定时任务」分组，且 tab 条要能把深链进来的任务会话 resolve 出标题。
export function listTaskSessions(): ApiSession[] {
  const db = getDB();
  const rows = db
    .prepare(
      `SELECT ${SESSION_COLS} FROM sessions WHERE archived = 0 AND kind = 'task'
       ORDER BY updated_at DESC`,
    )
    .all() as SessionRow[];
  return rows.map(rowToSession);
}

// B2: count archived sessions — drives the "显示已归档 (N)" toggle label.
export function countArchivedSessions(): number {
  const db = getDB();
  // 与 listSessions 的归档视图同一口径：任务会话也计入（能找回才敢归档）。
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE archived = 1 AND kind IN ('user','task','lark')",
    )
    .get() as { n: number };
  return row.n;
}

// B2: soft-archive / restore. Mirrors renameSession (bumps updated_at so the
// restored row re-sorts to the top). Returns the updated session, or null if
// the id doesn't exist. NEVER touches nodes / jsonl — purely reversible.
export function setSessionArchived(
  sessionId: string,
  archived: boolean,
  now: number,
): ApiSession | null {
  const db = getDB();
  const result = db
    .prepare(
      "UPDATE sessions SET archived = ?, updated_at = ? WHERE id = ?",
    )
    .run(archived ? 1 : 0, now, sessionId);
  if (result.changes === 0) return null;
  return getSession(sessionId);
}

// Per-session model lock. Persists the chosen ProviderId on the session row so
// switching sessions restores each one's own model instead of inheriting the
// global picker. Does NOT bump updated_at — changing the model isn't activity
// that should re-sort the session list. Returns the updated session or null.
export function setSessionModel(
  sessionId: string,
  model: string,
): ApiSession | null {
  const db = getDB();
  const result = db
    .prepare("UPDATE sessions SET model = ? WHERE id = ?")
    .run(model, sessionId);
  if (result.changes === 0) return null;
  return getSession(sessionId);
}

export function getSession(id: string): ApiSession | null {
  const db = getDB();
  const row = db
    .prepare(
      `SELECT ${SESSION_COLS} FROM sessions WHERE id = ?`,
    )
    .get(id) as SessionRow | undefined;
  return row ? rowToSession(row) : null;
}

// Returns the workspace_path for a session, or null. Used by route +
// claudeSessionPath to derive the encoded-cwd dir for jsonl lookup.
export function getSessionWorkspacePath(sessionId: string): string | null {
  const db = getDB();
  const row = db
    .prepare("SELECT workspace_path FROM sessions WHERE id = ?")
    .get(sessionId) as { workspace_path: string | null } | undefined;
  return row?.workspace_path ?? null;
}

// Returns the locked context_mode for a session. Used by route to
// override request-body mode (which is ignored except for the
// session-creation root request).
export function getSessionMode(sessionId: string): string | null {
  const db = getDB();
  const row = db
    .prepare("SELECT context_mode FROM sessions WHERE id = ?")
    .get(sessionId) as { context_mode: string } | undefined;
  return row?.context_mode ?? null;
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
  // Collect every claude session jsonl bound to this trellis session. project
  // stores one id per root (tree-shared); chat B-fork stores one per NODE — so
  // collect ALL non-null ids, not just roots, or B-fork transcripts leak. The
  // spawn cwd (sessionCwd) decides the encoded-cwd dir the jsonl lives in,
  // identical for every node in the session.
  const meta = db
    .prepare(
      "SELECT context_mode AS mode, workspace_path AS wp, origin FROM sessions WHERE id = ?",
    )
    .get(id) as
    | { mode: string; wp: string | null; origin: string }
    | undefined;
  const claudeIdRows = db
    .prepare(
      `SELECT claude_session_id FROM nodes
       WHERE session_id = ? AND claude_session_id IS NOT NULL`,
    )
    .all(id) as { claude_session_id: string }[];
  const codexIdRows = db
    .prepare(
      `SELECT DISTINCT codex_session_id FROM nodes
       WHERE session_id = ? AND codex_session_id IS NOT NULL`,
    )
    .all(id) as { codex_session_id: string }[];
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  // FK cascade nukes nodes/notes but the FTS virtual table isn't on the
  // FK graph — do it explicitly.
  ftsDeleteBySession(db, id);
  // cli-import 镜像的 jsonl 是用户的原始 CLI 历史，绝不能跟着删 —— 只清 DB 行。
  if (meta && meta.origin !== "cli-import") {
    const cwd = sessionCwd(meta.mode as Mode, meta.wp);
    for (const r of claudeIdRows) {
      try {
        fs.unlinkSync(claudeSessionPath(r.claude_session_id, cwd));
      } catch {
        // jsonl may have been moved/deleted manually — best effort.
      }
    }
    // codex rollouts leak the same way (linear codex chains share one sid —
    // hence DISTINCT). Path is found by id scan, cwd-independent.
    for (const r of codexIdRows) deleteCodexRollout(r.codex_session_id);
  }
}

// Resume ids are provider-family-scoped — claude ids live in
// claude_session_id, codex ids in codex_session_id, and mock never resumes.
// Map a family to its column (null = no resumable column for this family).
function resumeColumnForFamily(family: ProviderFamily): string | null {
  if (family === "claude") return "claude_session_id";
  if (family === "codex") return "codex_session_id";
  return null; // mock
}

// Family-dispatched "can this resume id still be honored?" check. claude keeps
// its historical convention: only validated when the caller passed a
// workspacePath (undefined = opted out). codex rollouts are cwd-independent —
// validate whenever asked (scan ~/.codex/sessions by id).
function resumeTargetExists(
  family: ProviderFamily,
  id: string,
  workspacePath?: string | null,
): boolean {
  if (family === "claude") {
    return workspacePath === undefined || claudeJsonlExists(id, workspacePath);
  }
  if (family === "codex") return codexRolloutExists(id);
  return true; // mock — unreachable (no resume column)
}

// True iff the claude CLI transcript for `id` still exists on disk. Used to
// self-heal: historically-polluted rows (a codex id stranded in
// claude_session_id before family isolation) and rows whose jsonl was
// manually cleaned both fail this check, so we fall back to a fresh session
// instead of feeding `claude --resume` an id it can't honor.
export function claudeJsonlExists(
  id: string,
  workspacePath: string | null,
): boolean {
  try {
    return fs.existsSync(claudeSessionPath(id, workspacePath));
  } catch {
    return false;
  }
}

// Per-lineage 隔离开关（server-internal，不进 ApiSession——客户端无需感知）。
// true = 该 session 的 project resume 走 per-lineage 路由（spec:
// progress/project-lineage-isolation-spec.md）。存量行 / 非 project 恒 false。
export function isLineageIsolated(sessionId: string): boolean {
  const db = getDB();
  const row = db
    .prepare("SELECT lineage_isolation FROM sessions WHERE id = ?")
    .get(sessionId) as { lineage_isolation: number } | undefined;
  return row?.lineage_isolation === 1;
}

// Walk up the parent chain from `nodeId` until parent_id IS NULL (the root of
// this branch's lineage), and return that root's resume id for `family`. In
// project mode this is the id that the provider's `--resume` should target so
// the branch continues its root's conversation. Returns null when:
//   - family is "mock" (never resumable)
//   - nodeId doesn't exist
//   - the root's column for this family is unset (first turn of a
//     fresh-context root, or the root's first turn ran a different family —
//     spawn without --resume; session_init will populate it)
//   - (claude only) workspacePath is provided and the transcript jsonl no
//     longer exists on disk — treat as fresh, self-healing stale/polluted ids
export function getRootResumeIdForNode(
  nodeId: string,
  family: ProviderFamily,
  workspacePath?: string | null,
): string | null {
  const col = resumeColumnForFamily(family);
  if (!col) return null; // mock
  const db = getDB();
  const stmt = db.prepare(
    `SELECT parent_id, ${col} AS resume_id FROM nodes WHERE id = ?`,
  );
  let cur: string | null = nodeId;
  // Hard cap walk depth so a broken chain (shouldn't happen but DB-level
  // cycles are technically possible after manual edits) can't spin.
  for (let i = 0; i < 1000 && cur; i++) {
    const row = stmt.get(cur) as
      | { parent_id: string | null; resume_id: string | null }
      | undefined;
    if (!row) return null;
    if (row.parent_id === null) {
      const id = row.resume_id;
      if (!id) return null;
      if (!resumeTargetExists(family, id, workspacePath)) return null;
      return id;
    }
    cur = row.parent_id;
  }
  return null;
}

// Walk up to the root and set its resume id for `family`. Called from
// run-bus on `session_init` so the freshly-spawned CLI session id sticks to
// whichever root this stream belongs to, in the family-correct column. mock
// has no resumable column, so it's a no-op.
export function setRootResumeIdForNode(
  nodeId: string,
  family: ProviderFamily,
  resumeId: string,
): void {
  const col = resumeColumnForFamily(family);
  if (!col) return; // mock
  const db = getDB();
  const stmt = db.prepare("SELECT parent_id FROM nodes WHERE id = ?");
  let cur: string | null = nodeId;
  for (let i = 0; i < 1000 && cur; i++) {
    const row = stmt.get(cur) as { parent_id: string | null } | undefined;
    if (!row) return;
    if (row.parent_id === null) {
      db.prepare(`UPDATE nodes SET ${col} = ? WHERE id = ?`).run(resumeId, cur);
      return;
    }
    cur = row.parent_id;
  }
}

// Per-node resume id — chat B-fork stores each node's OWN forked session id on
// the node itself (NOT walked up to root like project's setRootResumeIdForNode).
// The child node later resumes its immediate parent's session via --fork-session,
// inheriting the parent's history KV cache while branching into an isolated
// session (so sibling branches don't cross-pollute). Called from run-bus on
// session_init for chat mode, every turn (not just the first).
/** S88：记下这一轮实际由哪个 Agent 作答。
 *
 * agent 定义是 **live 引用**（改了定义，引用它的老会话跟着变），所以这一列是
 * 事后唯一能追溯「当时是谁答的」的线索 —— 会话级人设也记，不只 @提及。
 * scope='mention' = 这一轮由外援单独作答、主线人格不变（UI 据此挂 chip）。 */
export function setNodeAgent(
  nodeId: string,
  agentId: string,
  scope: "session" | "mention",
): void {
  getDB()
    .prepare("UPDATE nodes SET agent_id = ?, agent_scope = ? WHERE id = ?")
    .run(agentId, scope, nodeId);
}

export function setNodeResumeId(
  nodeId: string,
  family: ProviderFamily,
  resumeId: string,
): void {
  const col = resumeColumnForFamily(family);
  if (!col) return; // mock
  const db = getDB();
  db.prepare(`UPDATE nodes SET ${col} = ? WHERE id = ?`).run(resumeId, nodeId);
}

// Read the IMMEDIATE PARENT node's resume id for `family` — chat B-fork resumes
// the parent's forked session (vs project's getRootResumeIdForNode which shares
// the root's id across the whole tree). Returns null when: family is mock,
// node/parent missing, the parent is a root with no session yet (chat's first
// turn — spawn fresh without --fork-session), or (claude only) the parent's
// transcript jsonl was cleaned (self-heal to fresh, same discipline as
// getRootResumeIdForNode).
export function getParentResumeId(
  nodeId: string,
  family: ProviderFamily,
  workspacePath?: string | null,
): string | null {
  const col = resumeColumnForFamily(family);
  if (!col) return null; // mock
  const db = getDB();
  const self = db
    .prepare("SELECT parent_id FROM nodes WHERE id = ?")
    .get(nodeId) as { parent_id: string | null } | undefined;
  if (!self || !self.parent_id) return null; // root: no parent session to fork
  const prow = db
    .prepare(`SELECT ${col} AS resume_id FROM nodes WHERE id = ?`)
    .get(self.parent_id) as { resume_id: string | null } | undefined;
  const id = prow?.resume_id;
  if (!id) return null;
  if (!resumeTargetExists(family, id, workspacePath)) return null; // stale/cleaned — fresh
  return id;
}

// User-driven session rename. Bumps updated_at so the picker re-sorts the
// row to the top (intentional: just-renamed sessions are most relevant).
// Returns the updated row, or null if the session id doesn't exist —
// caller surfaces 404. title_source = 'user' 是永久锁：自动命名（下方
// applyAutoTitle）此后对这行不再生效。
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
      "UPDATE sessions SET title = ?, title_source = 'user', updated_at = ? WHERE id = ?",
    )
    .run(trimmed.slice(0, 200), now, sessionId);
  if (result.changes === 0) return null;
  return getSession(sessionId);
}

// 自动命名写入。WHERE 里的 title_source 守卫做成原子的 —— 与并发的手动
// rename 竞态时（用户点了重命名、同一刻标题生成也回来了）用户永远赢。
// 刻意不 bump updated_at：自动命名不该影响 sidebar 的时间排序。
export function applyAutoTitle(sessionId: string, title: string): boolean {
  const db = getDB();
  const trimmed = title.trim();
  if (!trimmed) return false;
  const result = db
    .prepare(
      `UPDATE sessions SET title = ?, title_source = 'auto'
       WHERE id = ? AND title_source != 'user'`,
    )
    .run(trimmed.slice(0, 200), sessionId);
  return result.changes > 0;
}

// 自动命名的判定素材：已完成 QA 节点数（触发时机）+ 最近几轮问答（生成
// 输入）。turns 按时间正序返回，喂给标题生成器时「最近的在最后」。origin
// 从 DB 直取而不是信 route 层变量 —— retry 路径不回填 resolvedOrigin。
export function getSessionTitleContext(
  sessionId: string,
  recentTurns = 3,
): {
  doneCount: number;
  titleSource: string;
  origin: string;
  turns: { question: string; response: string }[];
} | null {
  const db = getDB();
  const meta = db
    .prepare("SELECT title_source, origin FROM sessions WHERE id = ?")
    .get(sessionId) as
    | { title_source: string; origin: string }
    | undefined;
  if (!meta) return null;
  const { c } = db
    .prepare(
      `SELECT COUNT(*) AS c FROM nodes
       WHERE session_id = ? AND status = 'done' AND kind = 'qa'`,
    )
    .get(sessionId) as { c: number };
  const rows = db
    .prepare(
      `SELECT question, response FROM nodes
       WHERE session_id = ? AND status = 'done' AND kind = 'qa'
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(sessionId, recentTurns) as { question: string; response: string }[];
  return {
    doneCount: c,
    titleSource: meta.title_source,
    origin: meta.origin,
    turns: rows.reverse(),
  };
}

// 服务端 app 级偏好 kv（app_settings 表）。value 传 null/空串 = 删行回默认。
export function getAppSetting(key: string): string | null {
  const db = getDB();
  const row = db
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setAppSetting(key: string, value: string | null): void {
  const db = getDB();
  const trimmed = value?.trim();
  if (!trimmed) {
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(key);
    return;
  }
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, trimmed, Date.now());
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

// 手动标回未读（卡片头 / 树面板行的 toggle）。幂等；返回节点是否存在。
export function markNodeUnread(nodeId: string): boolean {
  const db = getDB();
  const existing = db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(nodeId);
  if (!existing) return false;
  db.prepare("UPDATE nodes SET read_at = NULL WHERE id = ?").run(nodeId);
  return true;
}

// Save/unsave exactly one card. Bookmarking and read state are orthogonal;
// neither operation touches read_at. Callers that need to distinguish a
// missing node from an off-state should check getNode first.
export function setNodeBookmark(
  nodeId: string,
  on: boolean,
  now = Date.now(),
): number | null {
  const bookmarkedAt = on ? now : null;
  getDB()
    .prepare("UPDATE nodes SET bookmarked_at = ? WHERE id = ?")
    .run(bookmarkedAt, nodeId);
  return bookmarkedAt;
}

export function listBookmarks(opts: { limit?: number } = {}): Bookmark[] {
  const limit = Math.min(100, Math.max(1, Math.trunc(opts.limit ?? 50)));
  const rows = getDB()
    .prepare(
      `SELECT n.id AS node_id, n.session_id, s.title AS session_title,
              n.question, n.response, n.bookmarked_at, n.read_at, n.status
         FROM nodes n
         JOIN sessions s ON s.id = n.session_id
        WHERE n.bookmarked_at IS NOT NULL AND s.archived = 0
        ORDER BY n.bookmarked_at DESC, n.id
        LIMIT ?`,
    )
    .all(limit) as Array<{
    node_id: string;
    session_id: string;
    session_title: string;
    question: string;
    response: string;
    bookmarked_at: number;
    read_at: number | null;
    status: Bookmark["status"];
  }>;
  return rows.map((row) => ({
    nodeId: row.node_id,
    sessionId: row.session_id,
    sessionTitle: row.session_title,
    question: bookmarkSummary(row.question, BOOKMARK_QUESTION_LIMIT),
    response: bookmarkSummary(row.response, BOOKMARK_RESPONSE_LIMIT),
    bookmarkedAt: row.bookmarked_at,
    readAt: row.read_at,
    status: row.status,
  }));
}

// Walk the parent chain up to this node's tree root (parent_id IS NULL).
// Returns null if the node doesn't exist or the chain is broken/cyclic.
function treeRootIdOf(db: Database, nodeId: string): string | null {
  const stmt = db.prepare("SELECT parent_id FROM nodes WHERE id = ?");
  let cur: string | null = nodeId;
  for (let i = 0; i < 1000 && cur; i++) {
    const row = stmt.get(cur) as { parent_id: string | null } | undefined;
    if (!row) return null;
    if (row.parent_id === null) return cur;
    cur = row.parent_id;
  }
  return null;
}

// 树面板雪藏：把 nodeId 所在的整棵树标为隐藏/恢复。标记落在树根行上
// （分支节点的 hidden_at 恒 NULL）。幂等；返回根 id + 持久化后的 hiddenAt，
// 节点不存在时返回 null。
export function setTreeHidden(
  nodeId: string,
  hidden: boolean,
  now: number,
): { rootId: string; hiddenAt: number | null } | null {
  const db = getDB();
  const rootId = treeRootIdOf(db, nodeId);
  if (!rootId) return null;
  const hiddenAt = hidden ? now : null;
  db.prepare("UPDATE nodes SET hidden_at = ? WHERE id = ?").run(
    hiddenAt,
    rootId,
  );
  return { rootId, hiddenAt };
}

// 写即复活：树内发生了「写」（新分支/重试）→ 自动解除这棵树的雪藏。纯浏览
// 不触发（那是 readAt 的事）。createBranchNode / resetNodeForRetry 调用。
function reviveTreeForNode(db: Database, nodeId: string): void {
  const rootId = treeRootIdOf(db, nodeId);
  if (!rootId) return;
  db.prepare(
    "UPDATE nodes SET hidden_at = NULL WHERE id = ? AND hidden_at IS NOT NULL",
  ).run(rootId);
}

// Claude CLI stores session transcripts at
// ~/.claude/projects/<encoded-cwd>/<session_id>.jsonl, where encoded-cwd is
// the absolute cwd with EVERY non-alphanumeric char replaced by "-" (matching
// Claude Code's own encoding) — e.g. "/Users/me/.claude" → "-Users-me--claude"
// (the dot becomes "-" too). cwd is whatever we spawned claude from:
// workspace_path for project sessions, os.homedir() as the chat
// fallback.
//
// NOTE: the old encode only replaced "/", so any cwd with a dot/underscore
// mismatched → claudeJsonlExists() falsely reported "missing" →
// getRootResumeIdForNode() returned null → project mode silently lost history
// every turn. (Same bug also broke deleteSession's jsonl cleanup.)
export function claudeSessionPath(sessionId: string, cwd: string | null): string {
  let effectiveCwd = cwd ?? os.homedir();
  // Claude Code 编码 cwd 前先解 symlink（macOS /tmp → /private/tmp 实测如此）；
  // 不归一会导致含 symlink 的 workspace 下 resume 验证恒 false → 每轮静默丢历史。
  try {
    effectiveCwd = fs.realpathSync(effectiveCwd);
  } catch {
    /* 目录不存在等 — 保持原样，后续 existsSync 自然 false */
  }
  const encodedCwd = effectiveCwd.replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", encodedCwd, `${sessionId}.jsonl`);
}

export function createSessionWithRoot(args: {
  sessionId: string;
  nodeId: string;
  title: string;
  question: string;
  now: number;
  mode?: string;
  workspacePath?: string | null;
  systemPrompt?: string | null;
  model?: string | null;
  requireApproval?: boolean;
  agentId?: string | null;
  attachments?: NodeAttachment[];
}): { session: ApiSession; node: ApiNode } {
  const db = getDB();
  const mode = args.mode ?? "chat";
  const workspacePath = args.workspacePath ?? null;
  const systemPrompt = args.systemPrompt ?? null;
  const model = args.model ?? null;
  const requireApproval = args.requireApproval === true;
  const agentId = args.agentId ?? null;
  const attachmentsJson =
    args.attachments && args.attachments.length > 0
      ? JSON.stringify(args.attachments)
      : null;
  // S1：归组。在事务**外**解析 —— ensureWorkspaceForPath 要 spawn git，
  // 放进事务里会让写锁多握几十毫秒。解析失败（目录消失/无 git）返回 null，
  // session 照常创建、只是不归组：归属是锦上添花，绝不该拦住发消息。
  const workspaceId = workspacePath
    ? resolveWorkspaceId(workspacePath)
    : null;
  const tx = db.transaction(() => {
    // 新建 project session 一律走 per-lineage 隔离（spec:
    // progress/project-lineage-isolation-spec.md）；存量行保持 0（旧共享语义）。
    db.prepare(
      `INSERT INTO sessions (id, title, root_node_id, created_at, updated_at,
                             context_mode, workspace_path, workspace_id,
                             system_prompt, model,
                             lineage_isolation, require_approval, agent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      args.sessionId,
      args.title,
      args.nodeId,
      args.now,
      args.now,
      mode,
      workspacePath,
      workspaceId,
      systemPrompt,
      model,
      mode === "project" ? 1 : 0,
      requireApproval ? 1 : 0,
      agentId,
    );

    db.prepare(
      `INSERT INTO nodes (id, session_id, parent_id, parent_anchor_text, question, response, status, sibling_index, created_at, attachments_json)
       VALUES (?, ?, NULL, NULL, ?, '', 'streaming', 0, ?, ?)`,
    ).run(
      args.nodeId,
      args.sessionId,
      args.question,
      args.now,
      attachmentsJson,
    );
    // Stage 16: index the user-typed question immediately so search hits
    // it even before the response finishes streaming. response is empty
    // here, indexed later by finalizeNode.
    ftsUpsert(db, "node_question", args.nodeId, args.sessionId, args.question);
  });
  tx();
  return {
    session: getSession(args.sessionId)!,
    node: getNode(args.nodeId)!,
  };
}

// Attach a parallel root (parent_id=NULL, kind=qa) to an existing session.
// Used by the "新提问" canvas action: same session, fresh lineage. Mirrors
// createReferenceNode's "session must already exist" precondition.
export function createRootInSession(args: {
  sessionId: string;
  nodeId: string;
  question: string;
  now: number;
  attachments?: NodeAttachment[];
}): ApiNode {
  const db = getDB();
  const session = db
    .prepare("SELECT id FROM sessions WHERE id = ?")
    .get(args.sessionId);
  if (!session) throw new Error(`session ${args.sessionId} not found`);

  const attachmentsJson =
    args.attachments && args.attachments.length > 0
      ? JSON.stringify(args.attachments)
      : null;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO nodes (id, session_id, parent_id, parent_anchor_text, question, response, status, sibling_index, created_at, attachments_json)
       VALUES (?, ?, NULL, NULL, ?, '', 'streaming', 0, ?, ?)`,
    ).run(
      args.nodeId,
      args.sessionId,
      args.question,
      args.now,
      attachmentsJson,
    );
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
      args.now,
      args.sessionId,
    );
    ftsUpsert(db, "node_question", args.nodeId, args.sessionId, args.question);
  });
  tx();
  return getNode(args.nodeId)!;
}

export function createBranchNode(args: {
  nodeId: string;
  parentId: string;
  question: string;
  parentAnchor: { selectedText: string } | null;
  now: number;
  attachments?: NodeAttachment[];
}): ApiNode {
  const db = getDB();
  const parent = db
    .prepare("SELECT session_id FROM nodes WHERE id = ?")
    .get(args.parentId) as { session_id: string } | undefined;
  if (!parent) throw new Error(`parent node ${args.parentId} not found`);

  const siblingCount = db
    .prepare("SELECT COUNT(*) AS n FROM nodes WHERE parent_id = ?")
    .get(args.parentId) as { n: number };

  const attachmentsJson =
    args.attachments && args.attachments.length > 0
      ? JSON.stringify(args.attachments)
      : null;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO nodes (id, session_id, parent_id, parent_anchor_text, question, response, status, sibling_index, created_at, attachments_json)
       VALUES (?, ?, ?, ?, ?, '', 'streaming', ?, ?, ?)`,
    ).run(
      args.nodeId,
      parent.session_id,
      args.parentId,
      args.parentAnchor?.selectedText ?? null,
      args.question,
      siblingCount.n,
      args.now,
      attachmentsJson,
    );
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
      args.now,
      parent.session_id,
    );
    ftsUpsert(
      db,
      "node_question",
      args.nodeId,
      parent.session_id,
      args.question,
    );
    // 写即复活：在雪藏树里继续提问 = 这棵树重新活了。
    reviveTreeForNode(db, args.parentId);
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
         token_cache_read = 0, token_cache_creation = 0,
         token_context = NULL,
         duration_ms = NULL,
         tool_calls_json = NULL,
         pending_interaction_json = NULL,
         final_start = NULL,
         codex_turn_ordinal = NULL
     WHERE id = ?`,
  ).run(nodeId);
  // The old response is gone; remove it from FTS so stale text doesn't
  // surface in searches during the retry window. node_question survives
  // (question text is preserved across retry). tool_calls cleared above
  // so the retried run starts with an empty panel.
  db.prepare(
    "DELETE FROM search_index WHERE source_id = ? AND source_kind = 'node_response'",
  ).run(nodeId);
  // 写即复活：重试也算「写」。
  reviveTreeForNode(db, nodeId);
  return {
    question: row.question,
    parentAnchor: row.parent_anchor_text
      ? { selectedText: row.parent_anchor_text }
      : null,
  };
}

// Read just the attachments column for a node. Used by /api/chat to
// resolve the image hashes attached to a question without rebuilding
// the whole ApiNode (retry / branch paths read this separately from
// the user-supplied attachments because retry doesn't carry them).
export function getNodeAttachments(nodeId: string): NodeAttachment[] {
  const db = getDB();
  const row = db
    .prepare("SELECT attachments_json FROM nodes WHERE id = ?")
    .get(nodeId) as { attachments_json: string | null } | undefined;
  if (!row?.attachments_json) return [];
  try {
    const parsed = JSON.parse(row.attachments_json);
    return Array.isArray(parsed) ? (parsed as NodeAttachment[]) : [];
  } catch {
    return [];
  }
}

// Stage 17: tool call mutations. Reads the tool_calls_json column,
// patches it, writes it back. Each run-bus event triggers exactly one
// of these. Serialising the whole array on every event is O(N) but N
// per turn is tiny (a few dozen at most) and the column is bounded by
// node lifetime, so the overhead is unmeasurable in practice.
export function appendToolCallStart(args: {
  nodeId: string;
  call: ToolCall;
}): void {
  const db = getDB();
  const row = db
    .prepare("SELECT tool_calls_json FROM nodes WHERE id = ?")
    .get(args.nodeId) as { tool_calls_json: string | null } | undefined;
  if (!row) return;
  let list: ToolCall[] = [];
  if (row.tool_calls_json) {
    try {
      const parsed = JSON.parse(row.tool_calls_json);
      if (Array.isArray(parsed)) list = parsed as ToolCall[];
    } catch {
      /* malformed → reset */
    }
  }
  // Defensive de-dup: if a tool_use_start event re-fires for the same
  // id (e.g. provider replays), keep the first entry.
  if (list.some((c) => c.id === args.call.id)) return;
  list.push(args.call);
  db.prepare("UPDATE nodes SET tool_calls_json = ? WHERE id = ?").run(
    JSON.stringify(list),
    args.nodeId,
  );
}

export function markToolCallDone(args: {
  nodeId: string;
  toolCallId: string;
  output: string | null;
  stderr: string | null;
  status: "done" | "error";
  endedAt: number;
}): void {
  const db = getDB();
  const row = db
    .prepare("SELECT tool_calls_json FROM nodes WHERE id = ?")
    .get(args.nodeId) as { tool_calls_json: string | null } | undefined;
  if (!row?.tool_calls_json) return;
  let list: ToolCall[];
  try {
    const parsed = JSON.parse(row.tool_calls_json);
    if (!Array.isArray(parsed)) return;
    list = parsed as ToolCall[];
  } catch {
    return;
  }
  const idx = list.findIndex((c) => c.id === args.toolCallId);
  if (idx === -1) return;
  const cur = list[idx];
  list[idx] = {
    ...cur,
    output: args.output,
    stderr: args.stderr,
    status: args.status,
    endedAt: args.endedAt,
    durationMs: Math.max(0, args.endedAt - cur.startedAt),
  };
  db.prepare("UPDATE nodes SET tool_calls_json = ? WHERE id = ?").run(
    JSON.stringify(list),
    args.nodeId,
  );
}

// Stage 22: merge a sub-agent progress patch into the Task/Agent call that
// spawned it. Same read-patch-write shape as markToolCallDone; the merge is
// shallow and additive (a later progress-only patch must not wipe the summary
// an earlier phase already delivered), and undefined values are dropped so a
// missing key never erases a known one.
export function patchToolCallAgent(args: {
  nodeId: string;
  toolCallId: string;
  patch: TaskMeta;
}): void {
  const db = getDB();
  const row = db
    .prepare("SELECT tool_calls_json FROM nodes WHERE id = ?")
    .get(args.nodeId) as { tool_calls_json: string | null } | undefined;
  if (!row?.tool_calls_json) return;
  let list: ToolCall[];
  try {
    const parsed = JSON.parse(row.tool_calls_json);
    if (!Array.isArray(parsed)) return;
    list = parsed as ToolCall[];
  } catch {
    return;
  }
  const idx = list.findIndex((c) => c.id === args.toolCallId);
  if (idx === -1) return;
  const cur = list[idx];
  list[idx] = { ...cur, agent: mergeAgentMeta(cur.agent, args.patch) };
  db.prepare("UPDATE nodes SET tool_calls_json = ? WHERE id = ?").run(
    JSON.stringify(list),
    args.nodeId,
  );
}

// Shared by repo + run-bus: additive shallow merge with undefined stripped.
export function mergeAgentMeta(
  cur: TaskMeta | undefined,
  patch: TaskMeta,
): TaskMeta {
  const next: TaskMeta = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (next as Record<string, unknown>)[k] = v;
  }
  return next;
}

export function getNodeToolCalls(nodeId: string): ToolCall[] {
  const db = getDB();
  const row = db
    .prepare("SELECT tool_calls_json FROM nodes WHERE id = ?")
    .get(nodeId) as { tool_calls_json: string | null } | undefined;
  if (!row?.tool_calls_json) return [];
  try {
    const parsed = JSON.parse(row.tool_calls_json);
    return Array.isArray(parsed) ? (parsed as ToolCall[]) : [];
  } catch {
    return [];
  }
}

// A路②: persist the in-flight interactive-tool prompt so a reload / reconnect
// can re-render the waiting form. Overwrites any prior pending value (only one
// interaction is in flight per node at a time). No-op if the node vanished.
export function persistPendingInteraction(
  nodeId: string,
  pending: PendingInteraction,
): void {
  const db = getDB();
  db.prepare(
    "UPDATE nodes SET pending_interaction_json = ? WHERE id = ?",
  ).run(JSON.stringify(pending), nodeId);
}

// A路②: clear the pending interaction once the user answered (or the run
// aborted). Idempotent.
export function clearPendingInteraction(nodeId: string): void {
  const db = getDB();
  db.prepare(
    "UPDATE nodes SET pending_interaction_json = NULL WHERE id = ?",
  ).run(nodeId);
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
  // Main-agent context-window occupancy (last assistant message). null when the
  // backend can't report it; persisted as-is so the % gauge survives reload.
  tokenContext?: number | null;
  // response 分层偏移（run-bus 流式期间维护的 finalStart）。0/undefined → NULL
  // （不分层）。error 态也照写 —— 部分文本上分层依旧成立。
  finalStart?: number;
  durationMs?: number | null;
  now: number;
}): void {
  const db = getDB();
  const node = db
    .prepare("SELECT session_id, response FROM nodes WHERE id = ?")
    .get(args.nodeId) as { session_id: string; response: string } | undefined;
  if (!node) return;
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE nodes
       SET status = ?, error_message = ?,
           token_input = ?, token_output = ?,
           token_cache_read = ?, token_cache_creation = ?,
           token_context = ?, final_start = ?,
           duration_ms = ?,
           pending_interaction_json = NULL
       WHERE id = ?`,
    ).run(
      args.status,
      args.errorMessage ?? null,
      args.tokenInput,
      args.tokenOutput,
      args.tokenCacheRead,
      args.tokenCacheCreation,
      args.tokenContext ?? null,
      args.finalStart || null,
      args.durationMs ?? null,
      args.nodeId,
    );
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
      args.now,
      node.session_id,
    );
    // Index the (final) response text only on success — errored streams
    // leave behind partial / nonsensical text that's noise in search.
    if (args.status === "done") {
      ftsUpsert(
        db,
        "node_response",
        args.nodeId,
        node.session_id,
        node.response,
      );
    } else {
      db.prepare(
        "DELETE FROM search_index WHERE source_id = ? AND source_kind = 'node_response'",
      ).run(args.nodeId);
    }
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
  mode?: string;
  workspacePath?: string | null;
}): { session: ApiSession; node: ApiNode } {
  const db = getDB();
  const status = args.status ?? "done";
  const mode = args.mode ?? "chat";
  const workspacePath = args.workspacePath ?? null;
  const workspaceId = workspacePath ? resolveWorkspaceId(workspacePath) : null;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO sessions (id, title, root_node_id, created_at, updated_at,
                             context_mode, workspace_path, workspace_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      args.sessionId,
      args.title,
      args.nodeId,
      args.now,
      args.now,
      mode,
      workspacePath,
      workspaceId,
    );

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
    ftsUpsert(
      db,
      "node_reference",
      args.nodeId,
      args.sessionId,
      args.contentMd,
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
    ftsUpsert(
      db,
      "node_reference",
      args.nodeId,
      args.sessionId,
      args.contentMd,
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
    ftsUpsert(
      db,
      "node_reference",
      args.nodeId,
      row.session_id,
      args.contentMd,
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

  // Status mirrors the fetch outcome so the UI flips out of the previous
  // error state on a successful refresh. Without this, an old run that
  // ended with `status='error'` (e.g. claude API blip after content was
  // already written) leaves the card looking failed even though the
  // content + meta have been replaced with a fresh good copy.
  const hasContent = args.contentMd.length > 0;
  const fetchError = args.meta.fetchError;
  const nextStatus: "done" | "error" =
    hasContent && !fetchError ? "done" : "error";
  const nextErrorMessage = nextStatus === "error" ? fetchError ?? null : null;

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE nodes
       SET ref_content_md = ?, ref_meta_json = ?, ref_fetched_at = ?,
           status = ?, error_message = ?
       WHERE id = ?`,
    ).run(
      args.contentMd,
      JSON.stringify(args.meta),
      args.now,
      nextStatus,
      nextErrorMessage,
      args.nodeId,
    );
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
      args.now,
      row.session_id,
    );
    ftsUpsert(
      db,
      "node_reference",
      args.nodeId,
      row.session_id,
      args.contentMd,
    );
  });
  tx();
  return getNode(args.nodeId);
}

// ---------------------------------------------------------------------------
// Notes (notebook — see progress/README.md current focus)
// ---------------------------------------------------------------------------

export type ApiNote = {
  id: string;
  sessionId: string;
  sourceNodeId: string;
  quotedText: string;
  createdAt: number;
};

type NoteRow = {
  id: string;
  session_id: string;
  source_node_id: string;
  quoted_text: string;
  created_at: number;
};

function rowToNote(r: NoteRow): ApiNote {
  return {
    id: r.id,
    sessionId: r.session_id,
    sourceNodeId: r.source_node_id,
    quotedText: r.quoted_text,
    createdAt: r.created_at,
  };
}

export function listNotesBySession(sessionId: string): ApiNote[] {
  const db = getDB();
  // newest first — drawer typically reads top-down "what did I just capture"
  const rows = db
    .prepare(
      "SELECT id, session_id, source_node_id, quoted_text, created_at FROM notes WHERE session_id = ? ORDER BY created_at DESC",
    )
    .all(sessionId) as NoteRow[];
  return rows.map(rowToNote);
}

export function createNote(args: {
  noteId: string;
  sessionId: string;
  sourceNodeId: string;
  quotedText: string;
  now: number;
}): ApiNote {
  const db = getDB();
  // Validate session + source node exist before inserting — DB has FK on
  // session_id but not source_node_id, so we need an explicit check
  // (otherwise a stale client could create dangling notes).
  const sourceOk = db
    .prepare("SELECT 1 FROM nodes WHERE id = ? AND session_id = ?")
    .get(args.sourceNodeId, args.sessionId);
  if (!sourceOk) {
    throw new Error("source node not found in this session");
  }
  db.prepare(
    "INSERT INTO notes (id, session_id, source_node_id, quoted_text, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    args.noteId,
    args.sessionId,
    args.sourceNodeId,
    args.quotedText,
    args.now,
  );
  ftsUpsert(db, "note", args.noteId, args.sessionId, args.quotedText);
  return {
    id: args.noteId,
    sessionId: args.sessionId,
    sourceNodeId: args.sourceNodeId,
    quotedText: args.quotedText,
    createdAt: args.now,
  };
}

export function deleteNote(noteId: string): boolean {
  const db = getDB();
  const r = db.prepare("DELETE FROM notes WHERE id = ?").run(noteId);
  if (r.changes > 0) {
    db.prepare(
      "DELETE FROM search_index WHERE source_id = ? AND source_kind = 'note'",
    ).run(noteId);
  }
  return r.changes > 0;
}

// Cascade-delete a node and every descendant qa node + every reference
// node in that subtree, plus all notes whose source_node_id falls inside.
// Refuses three cases: node missing, node is the session's qa root (use
// deleteSession instead), and any node in the subtree is currently
// streaming (caller should abort first). The delete runs as a single
// transaction so partial failure can't orphan part of the tree.
export type DeleteNodeResult =
  | { ok: true; deletedNodeIds: string[]; deletedNoteIds: string[] }
  | { ok: false; reason: "not_found" | "is_session_root" | "streaming" };

export function deleteNodeSubtree(nodeId: string): DeleteNodeResult {
  const db = getDB();
  const node = getNode(nodeId);
  if (!node) return { ok: false, reason: "not_found" };
  const session = getSession(node.sessionId);
  if (session?.rootNodeId === nodeId) {
    return { ok: false, reason: "is_session_root" };
  }
  // Collect every id in the subtree (parent included) via recursive CTE.
  const subtreeRows = db
    .prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM nodes WHERE id = ?
         UNION ALL
         SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.id
       )
       SELECT id FROM subtree`,
    )
    .all(nodeId) as { id: string }[];
  const ids = subtreeRows.map((r) => r.id);
  if (ids.length === 0) return { ok: false, reason: "not_found" };
  const placeholders = ids.map(() => "?").join(",");
  const stillStreaming = db
    .prepare(
      `SELECT COUNT(*) AS n FROM nodes
       WHERE id IN (${placeholders}) AND status = 'streaming'`,
    )
    .get(...ids) as { n: number };
  if (stillStreaming.n > 0) return { ok: false, reason: "streaming" };
  const noteRows = db
    .prepare(
      `SELECT id FROM notes WHERE source_node_id IN (${placeholders})`,
    )
    .all(...ids) as { id: string }[];
  const noteIds = noteRows.map((r) => r.id);
  // Per-node claude session jsonls leak unless cleaned here. project shares one
  // id per root (tree-shared), chat B-fork stores one per NODE — collect ALL
  // non-null ids in the subtree, same discipline as deleteSession. Read before
  // the tx deletes the rows. codex jsonls are skipped (their path embeds a date
  // we can't derive from the id), mirroring deleteSession.
  const claudeIdRows = db
    .prepare(
      `SELECT claude_session_id FROM nodes
       WHERE id IN (${placeholders}) AND claude_session_id IS NOT NULL`,
    )
    .all(...ids) as { claude_session_id: string }[];
  const codexIdRows = db
    .prepare(
      `SELECT DISTINCT codex_session_id FROM nodes
       WHERE id IN (${placeholders}) AND codex_session_id IS NOT NULL`,
    )
    .all(...ids) as { codex_session_id: string }[];
  const tx = db.transaction(() => {
    if (noteIds.length) {
      db.prepare(
        `DELETE FROM notes WHERE id IN (${noteIds.map(() => "?").join(",")})`,
      ).run(...noteIds);
    }
    db.prepare(`DELETE FROM nodes WHERE id IN (${placeholders})`).run(...ids);
    db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(
      Date.now(),
      node.sessionId,
    );
    // FTS is a virtual table — no FK cascade. Wipe every row tied to a
    // deleted node or note. source_id collisions between kinds are not
    // possible (UUIDs), so a single IN clause covers all four kinds.
    ftsDeleteByIds(db, [...ids, ...noteIds]);
  });
  tx();
  // Best-effort jsonl cleanup after the DB rows are gone. cli-import rows mirror
  // user-owned Claude CLI history, so attached nodes must never unlink source
  // jsonl files even when they carry per-lineage claude_session_id values.
  if (session && session.origin !== "cli-import" && claudeIdRows.length) {
    const cwd = sessionCwd(session.mode as Mode, session.workspacePath);
    for (const r of claudeIdRows) {
      try {
        fs.unlinkSync(claudeSessionPath(r.claude_session_id, cwd));
      } catch {
        // jsonl may have been moved/deleted manually — best effort.
      }
    }
  }
  if (session && session.origin !== "cli-import" && codexIdRows.length) {
    // codex resume keeps the SAME sid down a linear chain, so nodes outside
    // the deleted subtree (ancestors) may still hold this id — only unlink
    // rollouts nobody references anymore. (claude B-fork ids are per-node
    // unique via --fork-session, so it never needs this check.)
    const stillUsed = db.prepare(
      "SELECT 1 FROM nodes WHERE codex_session_id = ? LIMIT 1",
    );
    for (const r of codexIdRows) {
      if (!stillUsed.get(r.codex_session_id)) {
        deleteCodexRollout(r.codex_session_id);
      }
    }
  }
  return { ok: true, deletedNodeIds: ids, deletedNoteIds: noteIds };
}

// ---------------------------------------------------------------------------
// Stage 16: search API. One MATCH against search_index, JOIN sessions for
// title / mode / workspace metadata, group hits by session JS-side. Snippet
// is rendered server-side with FTS5's snippet() — UI receives both the
// <mark>-highlighted html-safe snippet and the raw matchText for the
// NodeFullView pulse injection.
// ---------------------------------------------------------------------------

export type SearchHit = {
  sourceKind: "node_question" | "node_response" | "node_reference" | "note";
  sourceId: string;
  snippet: string;
  matchText: string;
};

export type SearchResult = {
  sessionId: string;
  sessionTitle: string;
  sessionMode: string;
  sessionWorkspacePath: string | null;
  hits: SearchHit[];
};

// trigram needs ≥ 3 chars per query token. Below that, FTS5 returns 0
// rows; we short-circuit so callers can render a "type more" hint without
// a round-trip.
const MIN_QUERY_CHARS = 3;

// Wrap the user's raw query as a single FTS5 phrase. trigram tokenization
// makes phrase matching equivalent to substring matching — no boolean /
// prefix operators needed. Double quotes inside the query get doubled
// (FTS5's escape) so "a\"b" → "a""b". Lone double quotes that would break
// syntax are similarly defanged.
function buildFtsQuery(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length < MIN_QUERY_CHARS) return null;
  const escaped = trimmed.replace(/"/g, '""');
  return `"${escaped}"`;
}

export function searchAll(rawQuery: string, limit = 80): SearchResult[] {
  const ftsQuery = buildFtsQuery(rawQuery);
  if (!ftsQuery) return [];

  const db = getDB();
  type Row = {
    source_kind: string;
    source_id: string;
    session_id: string;
    snippet: string;
    match_text: string;
    title: string;
    context_mode: string;
    workspace_path: string | null;
    rank: number;
  };
  // Two snippet() calls share FTS5's positional offsets: `snippet` is
  // the display string with <mark> wrappers; `match_text` is the same
  // window with markers + ellipsis stripped, suitable for handing to the
  // DOM anchor injector (which needs an exact substring of the rendered
  // markdown).
  let rows: Row[];
  try {
    rows = db
      .prepare(
        `SELECT si.source_kind, si.source_id, si.session_id,
                snippet(search_index, 0, '<mark>', '</mark>', '…', 12) AS snippet,
                snippet(search_index, 0, '', '', '', 12) AS match_text,
                s.title, s.context_mode, s.workspace_path,
                bm25(search_index) AS rank
         FROM search_index si
         JOIN sessions s ON s.id = si.session_id
         WHERE search_index MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, limit) as Row[];
  } catch {
    // Defensive: a malformed escape or rare FTS5 syntax edge case. Treat
    // as "no results" rather than 500ing the route. The UI will show the
    // empty state.
    return [];
  }

  // Preserve bm25 order (already ASC) when grouping. Sessions surface in
  // the order their best hit was ranked.
  const groups = new Map<string, SearchResult>();
  for (const r of rows) {
    let g = groups.get(r.session_id);
    if (!g) {
      g = {
        sessionId: r.session_id,
        sessionTitle: r.title,
        sessionMode: r.context_mode,
        sessionWorkspacePath: r.workspace_path,
        hits: [],
      };
      groups.set(r.session_id, g);
    }
    g.hits.push({
      sourceKind: r.source_kind as SearchHit["sourceKind"],
      sourceId: r.source_id,
      snippet: r.snippet,
      matchText: r.match_text,
    });
  }
  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// 体验 A：发问时相似检测（duplicate-detection 式召回）。与 searchAll 的差别：
// searchAll 把整句包成单一 phrase（子串匹配，适合「记得原词」的 pull 式搜索）；
// 这里把草稿问题拆成多个 term 各查一次，按 session 聚合 term 覆盖度 —— 措辞
// 不同也能靠共享的实词/字序命中。宁漏报不误报：覆盖 < 2 个 term 的 session
// 不出（单 term 查询除外），archived 会话不出，调用方 UI 只做旁路提示。
// ---------------------------------------------------------------------------

export type RelatedSession = {
  sessionId: string;
  sessionTitle: string;
  sessionMode: string;
  sessionWorkspacePath: string | null;
  sessionUpdatedAt: number;
  // 代表性命中：该 session 里 bm25 最好的一条，作为「去续聊」的跳转落点。
  sourceKind: SearchHit["sourceKind"];
  sourceId: string;
  snippet: string;
  matchText: string;
  coveredTerms: number;
  totalTerms: number;
};

// 会话腔停用片段：任何两段对话都共享的问句用语。term 窗与它们互为子串即丢，
// 否则「覆盖 ≥2 term」的精度门槛会被「是什么 + 怎么用」这类组合击穿。抓大
// 放小 —— 长尾的低区分度窗交给 bm25 的 IDF 压权。
const RELATED_STOP_CJK = [
  "什么",
  "怎么",
  "怎样",
  "为啥",
  "如何",
  "可以",
  "能不能",
  "有没有",
  "是不是",
  "为什么",
  "帮我",
  "请问",
  "谢谢",
  "一下",
  "这个",
  "那个",
  "哪个",
  "哪些",
  "还是",
  "或者",
  "以及",
  "因为",
  "所以",
  "如果",
  "然后",
  "应该",
  "觉得",
  "知道",
  "理解",
  "解释",
  "讲讲",
  "看看",
  "问题",
  "时候",
  "东西",
  "地方",
  "方法",
  "方式",
  "情况",
  "意思",
  "区别",
];
const RELATED_STOP_ASCII = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "what",
  "how",
  "why",
  "can",
  "are",
  "was",
  "not",
  "you",
  "have",
  "from",
  "about",
]);

function isStopCjkWindow(w: string): boolean {
  return RELATED_STOP_CJK.some((s) => s.includes(w) || w.includes(s));
}

// 草稿问题 → 检索 term 集。ASCII/数字整词直取（trigram 子串语义下等价
// 「包含该词」，专名/技术词区分度最高，先推优先保留）；CJK 连续段 ≤4 字
// 整段、>4 字切 3 字窗步 2 + 尾窗对齐（覆盖段尾）。cap 8 控查询成本。
function extractRelatedTerms(raw: string, max = 8): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    if (t.length < MIN_QUERY_CHARS || seen.has(t)) return;
    seen.add(t);
    terms.push(t);
  };
  for (const m of raw.toLowerCase().matchAll(/[a-z0-9_#+./-]{3,}/g)) {
    const tok = m[0].replace(/^[./-]+|[./-]+$/g, "");
    if (tok.length < 3 || RELATED_STOP_ASCII.has(tok)) continue;
    push(tok);
  }
  for (const m of raw.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff]+/g)) {
    const run = m[0];
    if (run.length <= 4) {
      if (run.length >= MIN_QUERY_CHARS && !isStopCjkWindow(run)) push(run);
      continue;
    }
    for (let i = 0; i + 3 <= run.length; i += 2) {
      const w = run.slice(i, i + 3);
      if (!isStopCjkWindow(w)) push(w);
    }
    const tail = run.slice(-3);
    if (!isStopCjkWindow(tail)) push(tail);
  }
  return terms.slice(0, max);
}

export function findRelated(
  rawText: string,
  maxSessions = 3,
): { related: RelatedSession[]; totalTerms: number } {
  const terms = extractRelatedTerms(rawText);
  if (terms.length === 0) return { related: [], totalTerms: 0 };

  const db = getDB();
  type Row = {
    source_kind: string;
    source_id: string;
    session_id: string;
    snippet: string;
    match_text: string;
    title: string;
    context_mode: string;
    workspace_path: string | null;
    updated_at: number;
    rank: number;
  };
  const stmt = db.prepare(
    `SELECT si.source_kind, si.source_id, si.session_id,
            snippet(search_index, 0, '<mark>', '</mark>', '…', 12) AS snippet,
            snippet(search_index, 0, '', '', '', 12) AS match_text,
            s.title, s.context_mode, s.workspace_path, s.updated_at,
            bm25(search_index) AS rank
     FROM search_index si
     JOIN sessions s ON s.id = si.session_id
     WHERE search_index MATCH ? AND s.archived = 0
     ORDER BY rank
     LIMIT 20`,
  );

  type Agg = { covered: Set<string>; best: Row; updatedAt: number };
  const bySession = new Map<string, Agg>();
  for (const term of terms) {
    let rows: Row[];
    try {
      rows = stmt.all(`"${term.replace(/"/g, '""')}"`) as Row[];
    } catch {
      continue; // FTS5 语法边角 → 该 term 作废，不让整个请求 500
    }
    for (const r of rows) {
      const agg = bySession.get(r.session_id);
      if (!agg) {
        bySession.set(r.session_id, {
          covered: new Set([term]),
          best: r,
          updatedAt: r.updated_at,
        });
      } else {
        agg.covered.add(term);
        // bm25 越小越好（FTS5 返回负值，ORDER BY rank ASC = best first）
        if (r.rank < agg.best.rank) agg.best = r;
      }
    }
  }

  const minCovered = terms.length >= 2 ? 2 : 1;
  const ranked = [...bySession.values()]
    .filter((a) => a.covered.size >= minCovered)
    .sort(
      (x, y) =>
        y.covered.size - x.covered.size ||
        x.best.rank - y.best.rank ||
        y.updatedAt - x.updatedAt,
    )
    .slice(0, maxSessions);

  return {
    totalTerms: terms.length,
    related: ranked.map((a) => ({
      sessionId: a.best.session_id,
      sessionTitle: a.best.title,
      sessionMode: a.best.context_mode,
      sessionWorkspacePath: a.best.workspace_path,
      sessionUpdatedAt: a.updatedAt,
      sourceKind: a.best.source_kind as SearchHit["sourceKind"],
      sourceId: a.best.source_id,
      snippet: a.best.snippet,
      matchText: a.best.match_text,
      coveredTerms: a.covered.size,
      totalTerms: terms.length,
    })),
  };
}

// Cleanup leftover streaming nodes — call on server start. If the process
// crashed mid-stream, those nodes get marked as errored.
export function reapInterruptedStreams(): number {
  const db = getDB();
  const result = db
    .prepare(
      `UPDATE nodes SET status = 'error', error_message = 'interrupted',
              pending_interaction_json = NULL
       WHERE status = 'streaming'`,
    )
    .run();
  return result.changes;
}

// ── S133 最近链（侧栏「最近」分组）────────────────────────────────────
//
// 每条链（根→叶子 lineage）一行，按链上 max(created_at, read_at) 降序。递归
// CTE 从**可见根**出发（未归档的 user/lark 会话、未雪藏的树 —— 与 listSessions
// 和树面板同口径），沿 parent_id 下钻、逐级累计活动时间；没有子节点的即叶子
// = 链尾。任务会话（kind='task'）照 listSessions 排除：它们在侧栏有自己的组。
//
// 归组 / 截断 / 打标签在 lib/recent.ts（纯函数，可测）；这里只负责取行。
export function listRecentChains(limit = 200): RecentChainRow[] {
  const db = getDB();
  const rows = db
    .prepare(
      `WITH RECURSIVE chain(
         id, root_id, depth, activity, node_ids
       ) AS (
         SELECT n.id, n.id, 1, max(n.created_at, coalesce(n.read_at, 0)),
                n.id
           FROM nodes n JOIN sessions s ON s.id = n.session_id
          WHERE n.parent_id IS NULL AND n.hidden_at IS NULL
            AND s.archived = 0 AND s.kind IN ('user', 'lark')
         UNION ALL
         SELECT n.id, c.root_id, c.depth + 1,
                max(c.activity, n.created_at, coalesce(n.read_at, 0)),
                c.node_ids || char(31) || n.id
           FROM nodes n JOIN chain c ON n.parent_id = c.id
       )
       SELECT c.id AS tip_id, c.root_id, c.node_ids, c.depth, c.activity,
              t.session_id, t.question AS tip_question,
              t.topic_label AS tip_topic_label,
              t.status AS tip_status, t.read_at AS tip_read_at,
              (t.pending_interaction_json IS NOT NULL) AS tip_waiting,
              t.kind AS tip_kind, t.ref_meta_json AS tip_ref_meta_json,
              r.question AS root_question, r.topic_label AS root_topic_label,
              r.kind AS root_kind, r.ref_meta_json AS root_ref_meta_json,
              s.title AS session_title, s.context_mode AS session_mode,
              s.workspace_path AS session_workspace_path
         FROM chain c
         JOIN nodes t ON t.id = c.id
         JOIN nodes r ON r.id = c.root_id
         JOIN sessions s ON s.id = t.session_id
        WHERE NOT EXISTS (SELECT 1 FROM nodes k WHERE k.parent_id = c.id)
        ORDER BY c.activity DESC, c.id
        LIMIT ?`,
    )
    .all(limit) as Array<{
    tip_id: string;
    root_id: string;
    node_ids: string;
    depth: number;
    activity: number;
    session_id: string;
    tip_question: string;
    tip_topic_label: string | null;
    tip_status: string;
    tip_read_at: number | null;
    tip_waiting: number;
    tip_kind: string | null;
    tip_ref_meta_json: string | null;
    root_question: string;
    root_topic_label: string | null;
    root_kind: string | null;
    root_ref_meta_json: string | null;
    session_title: string;
    session_mode: string | null;
    session_workspace_path: string | null;
  }>;
  return rows.map((r) => ({
    sessionId: r.session_id,
    sessionTitle: r.session_title,
    sessionMode: r.session_mode ?? "chat",
    sessionWorkspacePath: r.session_workspace_path,
    tipId: r.tip_id,
    rootId: r.root_id,
    nodeIds: r.node_ids.split("\x1f"),
    depth: r.depth,
    activityAt: r.activity,
    tipQuestion: r.tip_question,
    tipTopicLabel: r.tip_topic_label,
    tipKind: r.tip_kind ?? "qa",
    tipRefTitle: refTitleOf(r.tip_ref_meta_json),
    tipStatus: r.tip_status,
    tipReadAt: r.tip_read_at,
    tipWaiting: r.tip_waiting === 1,
    rootQuestion: r.root_question,
    rootTopicLabel: r.root_topic_label,
    rootKind: r.root_kind ?? "qa",
    rootRefTitle: refTitleOf(r.root_ref_meta_json),
  }));
}

// 会话内未雪藏的树数 —— 最近分组据此决定链行要不要带树名前缀（单树会话
// 的树名就是会话标题的另一种说法，前缀是噪音）。
export function countVisibleTrees(sessionIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (sessionIds.length === 0) return out;
  const db = getDB();
  const rows = db
    .prepare(
      `SELECT session_id, COUNT(*) AS n FROM nodes
        WHERE parent_id IS NULL AND hidden_at IS NULL
          AND session_id IN (${sessionIds.map(() => "?").join(",")})
        GROUP BY session_id`,
    )
    .all(...sessionIds) as Array<{ session_id: string; n: number }>;
  for (const r of rows) out.set(r.session_id, r.n);
  return out;
}

function refTitleOf(metaJson: string | null): string | null {
  if (!metaJson) return null;
  try {
    const meta = JSON.parse(metaJson) as ReferenceMeta;
    return typeof meta?.title === "string" && meta.title ? meta.title : null;
  } catch {
    return null;
  }
}
