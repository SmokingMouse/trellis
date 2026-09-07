import { afterAll, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";

mock.module("server-only", () => ({}));

const root = mkdtempSync("/tmp/trellis-workspaces-");
const realDir = path.join(root, "real");
const aliasDir = path.join(root, "alias");
mkdirSync(realDir);
symlinkSync(realDir, aliasDir);

const { canonicalWorkspacePath, mergeDuplicateWorkspacePaths } = await import(
  "./workspaces"
);
const { mergeRecentWorkspaces } = await import(
  "../../app/api/workspaces/recent/route"
);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function migrationDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      git_branch TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL
    );
    INSERT INTO projects VALUES ('p');
  `);
  return db;
}

describe("workspace realpath identity", () => {
  test("canonical path collapses symlink aliases", () => {
    expect(canonicalWorkspacePath(aliasDir)).toBe(canonicalWorkspacePath(realDir));
    expect(canonicalWorkspacePath(path.join(root, "missing"))).toBe(
      path.join(root, "missing"),
    );
  });

  test("recent picker deduplicates aliases by realpath", () => {
    const rows = mergeRecentWorkspaces(
      [
        {
          path: aliasDir,
          shortName: "alias",
          lastUsedAt: 1,
          source: "trellis",
        },
      ],
      [
        {
          path: realDir,
          shortName: "real",
          lastUsedAt: 2,
          source: "trellis",
        },
      ],
      [
        {
          path: aliasDir,
          shortName: "alias",
          lastUsedAt: 3,
          source: "claude",
        },
      ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      path: canonicalWorkspacePath(realDir),
      lastUsedAt: 3,
      source: "both",
    });
  });

  test("startup merge keeps the highest-permission row and rewires every session", () => {
    const db = migrationDb();
    db.prepare(
      `INSERT INTO workspaces
       (id,project_id,name,path,kind,git_branch,created_by,created_at,last_used_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run("used", "p", "used", aliasDir, "worktree", "feature", "discovered", 1, 1);
    db.prepare(
      `INSERT INTO workspaces
       (id,project_id,name,path,kind,git_branch,created_by,created_at,last_used_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run("keeper", "p", "scan", realDir, "worktree", "feature", "trellis", 2, 2);
    db.prepare("INSERT INTO sessions VALUES (?,?)").run("s1", "used");

    expect(mergeDuplicateWorkspacePaths(db)).toEqual({ merged: 1, normalized: 1 });
    expect(
      db.prepare("SELECT id, path, created_by FROM workspaces").all(),
    ).toEqual([
      { id: "keeper", path: canonicalWorkspacePath(realDir), created_by: "trellis" },
    ]);
    expect(
      db.prepare("SELECT workspace_id FROM sessions WHERE id = 's1'").get(),
    ).toEqual({ workspace_id: "keeper" });

    expect(mergeDuplicateWorkspacePaths(db)).toEqual({ merged: 0, normalized: 0 });
    db.close();
  });
});
