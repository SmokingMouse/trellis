import "server-only";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const DB_DIR = path.join(os.homedir(), ".trellis");
const DB_PATH = path.join(DB_DIR, "data.db");

let _db: Database.Database | null = null;

export function getDB(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(DB_DIR, { recursive: true });
  const db = new Database(DB_PATH);
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
    `UPDATE nodes SET status = 'error', error_message = 'interrupted'
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
