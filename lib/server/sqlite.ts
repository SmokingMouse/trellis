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

  // Idempotent column add for cli-multi mode: each trellis session may bind
  // to one claude CLI session id (null in lean / cli-single).
  const hasClaudeSessionId = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'claude_session_id'",
    )
    .get();
  if (!hasClaudeSessionId) {
    db.exec("ALTER TABLE sessions ADD COLUMN claude_session_id TEXT");
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

  // Reap dangling streams from a previous server crash, exactly once on boot.
  db.prepare(
    `UPDATE nodes SET status = 'error', error_message = 'interrupted'
     WHERE status = 'streaming'`,
  ).run();
}
