import "server-only";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const DB_DIR = path.join(os.homedir(), ".trellis");
const DB_PATH = path.join(DB_DIR, "data.db");

let _db: Database.Database | null = null;

function dbPath(): string {
  return process.env.TRELLIS_DB_PATH || DB_PATH;
}

export function getDB(): Database.Database {
  if (_db) return _db;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  _db = db;
  return db;
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      root_node_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS sessions_updated_at ON sessions(updated_at);

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      parent_id TEXT,
      parent_anchor_text TEXT,
      question TEXT NOT NULL,
      response TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'streaming',
      error_message TEXT,
      sibling_index INTEGER NOT NULL DEFAULT 0,
      token_input INTEGER NOT NULL DEFAULT 0,
      token_output INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS nodes_session ON nodes(session_id);
    CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parent_id);
  `);

  // Idempotent column add for project mode: each trellis session may bind
  // to one claude CLI session id (null in chat / workspace).
  // Legacy: this column was authoritative pre-2026-05. After the per-root
  // upgrade, claude_session_id moved to nodes.claude_session_id (see below);
  // this column stays for backfill source + historical readability but is
  // no longer read at runtime.
  const hasClaudeSessionId = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'claude_session_id'",
    )
    .get();
  if (!hasClaudeSessionId) {
    db.exec("ALTER TABLE sessions ADD COLUMN claude_session_id TEXT");
  }

  // Per-root claude session id. Each root node (parent_id IS NULL, kind='qa')
  // in a project-mode session owns its own claude CLI session — so canvas
  // "新提问" gives the user a fresh context without losing the existing
  // tree's memory. Branches walk up to their root to find which claude
  // session to --resume. NULL on chat/workspace roots and on every branch.
  const hasNodeClaudeId = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('nodes') WHERE name = 'claude_session_id'",
    )
    .get();
  if (!hasNodeClaudeId) {
    db.exec("ALTER TABLE nodes ADD COLUMN claude_session_id TEXT");
    // Backfill: copy the legacy per-session id onto each session's primary
    // root node (sessions.root_node_id). Pre-upgrade, a session had exactly
    // one root that owned its claude id; that mapping is lossless.
    db.exec(`
      UPDATE nodes
      SET claude_session_id = (
        SELECT s.claude_session_id FROM sessions s WHERE s.id = nodes.session_id
      )
      WHERE id IN (
        SELECT root_node_id FROM sessions WHERE claude_session_id IS NOT NULL
      )
    `);
  }

  // Per-root codex session id — the codex sibling of claude_session_id.
  // Resume ids are provider-family-scoped (a codex CLI session can only be
  // resumed by codex, never by claude), so each family gets its own column;
  // storing them in one shared column let a codex id reach `claude --resume`
  // and fail with "No conversation found". NULL on chat/workspace roots,
  // every branch, and any root whose first turn ran a non-codex provider.
  const hasNodeCodexId = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('nodes') WHERE name = 'codex_session_id'",
    )
    .get();
  if (!hasNodeCodexId) {
    db.exec("ALTER TABLE nodes ADD COLUMN codex_session_id TEXT");
  }

  // Stage 14: per-session context mode + workspace cwd. See
  // progress/mode-workspace-rebuild.md. Mode previously lived in
  // localStorage as a global preference; now it's locked at session
  // creation so each tree carries its own context. Sessions with a
  // claude_session_id are migrated to 'project' (they were cli-multi);
  // everything else lands on 'chat' (lossless for lean; cli-single
  // sessions lose tool access — accepted, see spec migration section).
  const hasContextMode = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'context_mode'",
    )
    .get();
  if (!hasContextMode) {
    db.exec(
      "ALTER TABLE sessions ADD COLUMN context_mode TEXT NOT NULL DEFAULT 'chat'",
    );
    db.exec(
      "UPDATE sessions SET context_mode = 'project' WHERE claude_session_id IS NOT NULL",
    );
  }
  const hasWorkspacePath = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'workspace_path'",
    )
    .get();
  if (!hasWorkspacePath) {
    db.exec("ALTER TABLE sessions ADD COLUMN workspace_path TEXT");
  }

  // Wave 2 (B2): session archive flag. archived = soft-hide, fully reversible
  // (never touches jsonl / nodes — only filters lists). 0 = active, 1 =
  // archived. Idempotent ALTER following the same pattern as every column
  // above. Existing rows default to 0 (active) — lossless.
  const hasArchived = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'archived'",
    )
    .get();
  if (!hasArchived) {
    db.exec(
      "ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
    );
  }

  // D1: per-session custom system prompt (chat mode only — workspace/project
  // get their persona from CLAUDE.md + full tools). NULL = use the built-in
  // DEFAULT_SYSTEM_PROMPT. Locked at session creation like mode/workspace.
  const hasSystemPrompt = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'system_prompt'",
    )
    .get();
  if (!hasSystemPrompt) {
    db.exec("ALTER TABLE sessions ADD COLUMN system_prompt TEXT");
  }

  // Per-session model lock: stores the ProviderId (claude-opus / claude-sonnet
  // / claude-haiku / codex) chosen when the session was created, so switching
  // away and back doesn't silently inherit whatever the global picker last
  // pointed at. NULL = legacy rows → fall back to DEFAULT_PROVIDER on read.
  // Idempotent ALTER, same pattern as every column above.
  const hasModel = db
    .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'model'")
    .get();
  if (!hasModel) {
    db.exec("ALTER TABLE sessions ADD COLUMN model TEXT");
  }

  // CLI session 同步（progress/cli-sync.md）。一个 session 的来源：
  //   'native'     — trellis 自己造的（默认，所有既有行）
  //   'cli-import' — 从 ~/.claude/projects 的本地 CLI jsonl 镜像来的（只读）
  // source_jsonl_path = 镜像源 jsonl 绝对路径；synced_uuid = 上次同步到的末行
  // uuid（增量游标，watcher 据此只重解析新增部分）。后两者 native 行恒 NULL。
  const cliSyncCols: { name: string; sql: string }[] = [
    {
      name: "origin",
      sql: "ALTER TABLE sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'native'",
    },
    {
      name: "source_jsonl_path",
      sql: "ALTER TABLE sessions ADD COLUMN source_jsonl_path TEXT",
    },
    {
      name: "synced_uuid",
      sql: "ALTER TABLE sessions ADD COLUMN synced_uuid TEXT",
    },
  ];
  for (const c of cliSyncCols) {
    const has = db
      .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = ?")
      .get(c.name);
    if (!has) db.exec(c.sql);
  }

  // CLI branch alignment P1: one attached trellis session can bind a whole
  // lineage of Claude CLI jsonl files (root + fork sessions). The old
  // sessions.source_jsonl_path remains a denormalized root path; this table is
  // the authoritative member list and carries per-jsonl sync cursors.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cli_lineages (
      trellis_session_id TEXT NOT NULL,
      claude_session_id TEXT NOT NULL,
      jsonl_path TEXT NOT NULL,
      fork_point_uuid TEXT,
      is_root INTEGER NOT NULL DEFAULT 0,
      synced_uuid TEXT,
      PRIMARY KEY (trellis_session_id, claude_session_id),
      FOREIGN KEY (trellis_session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS cli_lineages_session ON cli_lineages(trellis_session_id);
  `);
  db.exec(`
    INSERT OR IGNORE INTO cli_lineages
      (trellis_session_id, claude_session_id, jsonl_path, fork_point_uuid, is_root, synced_uuid)
    SELECT id, id, source_jsonl_path, NULL, 1, synced_uuid
    FROM sessions
    WHERE origin = 'cli-import'
      AND source_jsonl_path IS NOT NULL
  `);

  // Idempotent column add for short LLM-generated topic label per node.
  // Used by overview rendering (LoD) and outline. Null until first done.
  const hasTopicLabel = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('nodes') WHERE name = 'topic_label'",
    )
    .get();
  if (!hasTopicLabel) {
    db.exec("ALTER TABLE nodes ADD COLUMN topic_label TEXT");
  }

  // Reference cards (Stage 12). Six idempotent column adds for the new
  // node kind. Existing qa rows get kind='qa' via DEFAULT and NULL refs.
  // See progress/reference-nodes.md for the data model rationale.
  const refColumns: { name: string; sql: string }[] = [
    { name: "kind", sql: "ALTER TABLE nodes ADD COLUMN kind TEXT NOT NULL DEFAULT 'qa'" },
    { name: "ref_source_type", sql: "ALTER TABLE nodes ADD COLUMN ref_source_type TEXT" },
    { name: "ref_source_uri", sql: "ALTER TABLE nodes ADD COLUMN ref_source_uri TEXT" },
    { name: "ref_content_md", sql: "ALTER TABLE nodes ADD COLUMN ref_content_md TEXT" },
    { name: "ref_fetched_at", sql: "ALTER TABLE nodes ADD COLUMN ref_fetched_at INTEGER" },
    { name: "ref_meta_json", sql: "ALTER TABLE nodes ADD COLUMN ref_meta_json TEXT" },
  ];
  for (const c of refColumns) {
    const has = db
      .prepare(
        "SELECT 1 FROM pragma_table_info('nodes') WHERE name = ?",
      )
      .get(c.name);
    if (!has) db.exec(c.sql);
  }

  // Idempotent: per-node read marker. NULL = unread; ms-since-epoch =
  // timestamp the user first kept the node open long enough to count as
  // read (1s gate, set client-side, persisted via POST /api/nodes/[id]/read).
  const hasReadAt = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('nodes') WHERE name = 'read_at'",
    )
    .get();
  if (!hasReadAt) {
    db.exec("ALTER TABLE nodes ADD COLUMN read_at INTEGER");
  }

  // Idempotent: split out cache token tracking so the UI can distinguish
  // net cost (input + output) from cache leverage (cache_read, often
  // dominant in cli-multi). Existing token_input / token_output columns
  // continue to mean "raw model input" / "model output" — old rows had
  // cache buckets summed into token_input via claude.ts; that's a
  // historical mis-attribution we accept (no migration to retroactively
  // fix). New rows get clean separation.
  const cacheCols: { name: string; sql: string }[] = [
    {
      name: "token_cache_read",
      sql: "ALTER TABLE nodes ADD COLUMN token_cache_read INTEGER NOT NULL DEFAULT 0",
    },
    {
      name: "token_cache_creation",
      sql: "ALTER TABLE nodes ADD COLUMN token_cache_creation INTEGER NOT NULL DEFAULT 0",
    },
  ];
  for (const c of cacheCols) {
    const has = db
      .prepare("SELECT 1 FROM pragma_table_info('nodes') WHERE name = ?")
      .get(c.name);
    if (!has) db.exec(c.sql);
  }

  // B (token fix): the main agent's true context-window occupancy for this
  // turn = the LAST assistant message's input+cache, NOT the result.usage sum
  // (which double-counts every tool-loop iteration + same-model subagents).
  // Nullable: legacy rows / codex-less-precise / non-claude → NULL → the % gauge
  // falls back to the old input+cache_read+cache_creation estimate.
  const hasTokenContext = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('nodes') WHERE name = 'token_context'",
    )
    .get();
  if (!hasTokenContext) {
    db.exec("ALTER TABLE nodes ADD COLUMN token_context INTEGER");
  }

  // Stage 15: image attachments on a node. JSON-encoded NodeAttachment[]
  // (see lib/types.ts). NULL means no attachments. Actual image bytes
  // live in ~/.trellis/blobs/<hash>.<ext>; the JSON only carries
  // metadata (hash, mime, size, filename, optional width/height).
  const hasAttachments = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('nodes') WHERE name = 'attachments_json'",
    )
    .get();
  if (!hasAttachments) {
    db.exec("ALTER TABLE nodes ADD COLUMN attachments_json TEXT");
  }

  // Stage 17: LLM tool invocations per node. JSON-encoded ToolCall[]
  // (see lib/types.ts). NULL when the turn didn't trigger any tools.
  // Mutated incrementally during the run via appendToolCallStart /
  // markToolCallDone — partial JSON is always well-formed because we
  // re-serialize the whole array on each update (cheap at the tool
  // call counts a single turn produces).
  const hasToolCalls = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('nodes') WHERE name = 'tool_calls_json'",
    )
    .get();
  if (!hasToolCalls) {
    db.exec("ALTER TABLE nodes ADD COLUMN tool_calls_json TEXT");
  }

  // A路②: in-flight interactive-tool prompt (AskUserQuestion / ExitPlanMode)
  // awaiting a user answer. JSON-encoded { toolUseId, toolName, input }. NULL
  // when nothing is pending. Persisted so a page reload / reconnect / late tab
  // can re-render the waiting form; cleared the moment the user responds (or
  // the run aborts). Only ever set while status='streaming'.
  const hasPendingInteraction = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('nodes') WHERE name = 'pending_interaction_json'",
    )
    .get();
  if (!hasPendingInteraction) {
    db.exec("ALTER TABLE nodes ADD COLUMN pending_interaction_json TEXT");
  }

  // Notebook: per-session free-form excerpts the user collects while
  // reading. Each row points back to its source node so the UI can offer
  // a "jump to source + scroll to mark" return path.
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      source_node_id TEXT NOT NULL,
      quoted_text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS notes_session ON notes(session_id);
  `);

  // CLI session 同步（Stage B，progress/cli-sync.md）：用户 opt-in 的 ~/.claude/
  // projects 子目录白名单。watcher 启动时 bulk 导入这些目录里的（非 trellis 自有）
  // jsonl，并 fs.watch 增量同步。删一条只停止同步、不删已镜像的 session。
  db.exec(`
    CREATE TABLE IF NOT EXISTS cli_sync_dirs (
      path TEXT PRIMARY KEY,
      added_at INTEGER NOT NULL
    );
  `);

  // Stage 16: FTS5 cross-session full-text search. Single virtual table
  // covers question / response / reference / note text. trigram tokenizer
  // is the FTS5-builtin pick for mixed CJK + ASCII: 3-char sliding window
  // gives substring matching across languages (the same trade as Notion /
  // Linear). UNINDEXED meta columns let us filter/JOIN without paying
  // inverted-index cost. See progress/fts-search.md for the data model.
  //
  // Min-query constraint: trigram needs ≥ 3 chars per token, so the API
  // and UI both short-circuit shorter queries with a hint.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
      text,
      source_kind UNINDEXED,
      source_id UNINDEXED,
      session_id UNINDEXED,
      tokenize = 'trigram'
    );
  `);

  // Reap dangling streams from a previous server crash, exactly once on boot.
  db.prepare(
    `UPDATE nodes SET status = 'error', error_message = 'interrupted',
            pending_interaction_json = NULL
     WHERE status = 'streaming'`,
  ).run();

  // First-boot backfill: if the search_index has zero rows but the DB
  // already holds data (upgrade from a pre-Stage-16 build), seed it
  // from the existing tables in a single transaction. Idempotent —
  // subsequent boots skip because COUNT > 0.
  const indexed = db
    .prepare("SELECT COUNT(*) AS n FROM search_index")
    .get() as { n: number };
  if (indexed.n === 0) {
    const haveNodes = db
      .prepare("SELECT COUNT(*) AS n FROM nodes")
      .get() as { n: number };
    const haveNotes = db
      .prepare("SELECT COUNT(*) AS n FROM notes")
      .get() as { n: number };
    if (haveNodes.n > 0 || haveNotes.n > 0) {
      const tx = db.transaction(() => {
        db.exec(`
          INSERT INTO search_index(text, source_kind, source_id, session_id)
          SELECT question, 'node_question', id, session_id
          FROM nodes WHERE kind = 'qa' AND question != '';

          INSERT INTO search_index(text, source_kind, source_id, session_id)
          SELECT response, 'node_response', id, session_id
          FROM nodes WHERE kind = 'qa' AND status = 'done' AND response != '';

          INSERT INTO search_index(text, source_kind, source_id, session_id)
          SELECT ref_content_md, 'node_reference', id, session_id
          FROM nodes WHERE kind = 'reference'
            AND ref_content_md IS NOT NULL AND ref_content_md != '';

          INSERT INTO search_index(text, source_kind, source_id, session_id)
          SELECT quoted_text, 'note', id, session_id
          FROM notes;
        `);
      });
      tx();
    }
  }
}
