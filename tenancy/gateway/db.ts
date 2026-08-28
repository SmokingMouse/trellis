import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

let cached: { path: string; db: Database } | null = null;

export function gatewayDBPath(): string {
  return process.env.TRELLIS_GW_DB || join(homedir(), ".trellis-tenancy", "gateway.db");
}

export function openGatewayDB(file = gatewayDBPath()): Database {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

export function getGatewayDB(): Database {
  const file = gatewayDBPath();
  if (cached?.path === file) return cached.db;
  cached?.db.close();
  cached = { path: file, db: openGatewayDB(file) };
  return cached.db;
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, pass_hash TEXT,
      invite_code TEXT, tenant TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER
    );
  `);

  // Migrations stay additive: old gateway DBs gain fields without losing data.
  const add = (table: string, name: string, ddl: string) => {
    const found = db
      .prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`)
      .get(name);
    if (!found) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  };
  add("users", "pass_hash", "TEXT");
  add("users", "invite_code", "TEXT");
  add("users", "disabled", "INTEGER NOT NULL DEFAULT 0");
  add("sessions", "last_seen_at", "INTEGER");
}
