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
const activeDir = path.join(root, "active");
const unusedDir = path.join(root, "unused");
mkdirSync(realDir);
mkdirSync(activeDir);
mkdirSync(unusedDir);
symlinkSync(realDir, aliasDir);

const {
  canonicalWorkspacePath,
  clearScanRegistrationRecency,
  ensureWorkspaceForPath,
  listProjectTree,
  mergeDuplicateWorkspacePaths,
  touchWorkspace,
} = await import("./workspaces");
const { mergeRecentWorkspaces, sortRecentWorkspaces } = await import(
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

function projectTreeDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cluster_key TEXT NOT NULL UNIQUE,
      git_remote TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
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
      workspace_id TEXT,
      updated_at INTEGER NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'user'
    );
    INSERT INTO projects VALUES ('p','repo','test:repo',NULL,1,1);
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

  test("recent picker keeps the newest same-source timestamp regardless of order", () => {
    const trellisRows = [
      {
        path: realDir,
        shortName: "real",
        lastUsedAt: 100,
        source: "trellis" as const,
      },
      {
        path: aliasDir,
        shortName: "alias",
        lastUsedAt: 5,
        source: "trellis" as const,
      },
    ];

    for (const rows of [trellisRows, [...trellisRows].reverse()]) {
      expect(mergeRecentWorkspaces([], rows, [])).toEqual([
        {
          path: canonicalWorkspacePath(realDir),
          shortName: path.basename(realDir),
          lastUsedAt: 100,
          source: "trellis",
        },
      ]);
    }
  });

  test("scan registration writes no recency timestamp", () => {
    const db = projectTreeDb();
    const id = ensureWorkspaceForPath(unusedDir, "worktree-scan", db);
    expect(id).toBeString();
    expect(
      db.prepare("SELECT last_used_at FROM workspaces WHERE id = ?").get(id!),
    ).toEqual({ last_used_at: null });
    db.close();
  });

  test("non-scan registration starts at created_at and UI use refreshes recency", () => {
    const db = projectTreeDb();
    const id = ensureWorkspaceForPath(unusedDir, "trellis", db);
    const discoveredId = ensureWorkspaceForPath(realDir, "discovered", db);
    expect(id).toBeString();
    expect(discoveredId).toBeString();
    for (const workspaceId of [id!, discoveredId!]) {
      const created = db
        .prepare(
          "SELECT created_at, last_used_at FROM workspaces WHERE id = ?",
        )
        .get(workspaceId) as { created_at: number; last_used_at: number };
      expect(created.last_used_at).toBe(created.created_at);
    }

    db.prepare("UPDATE workspaces SET last_used_at = 1 WHERE id = ?").run(id!);
    touchWorkspace(id!, db);
    const touched = db
      .prepare("SELECT last_used_at FROM workspaces WHERE id = ?")
      .get(id!) as { last_used_at: number };
    expect(touched.last_used_at).toBeGreaterThan(1);
    db.close();
  });

  test("a UI-created worktree ranks first in the sidebar and recent picker", () => {
    const db = projectTreeDb();
    const id = ensureWorkspaceForPath(unusedDir, "trellis", db);
    expect(id).toBeString();
    const workspace = db
      .prepare("SELECT project_id FROM workspaces WHERE id = ?")
      .get(id!) as { project_id: string };
    db.prepare(
      `INSERT INTO workspaces
       (id,project_id,name,path,kind,git_branch,created_by,created_at,last_used_at)
       VALUES ('old',?,'old',?,'worktree','old','trellis',1,1)`,
    ).run(workspace.project_id, activeDir);
    touchWorkspace(id!, db);

    const project = listProjectTree(db).find((p) => p.id === workspace.project_id);
    expect(project?.workspaces[0]?.id).toBe(id!);
    const recent = db
      .prepare("SELECT last_used_at FROM workspaces WHERE id = ?")
      .get(id!) as { last_used_at: number };
    const rows = sortRecentWorkspaces([
      { path: activeDir, shortName: "old", lastUsedAt: 1, source: "trellis" },
      {
        path: unusedDir,
        shortName: "unused",
        lastUsedAt: recent.last_used_at,
        source: "trellis",
      },
    ]);
    expect(rows[0]?.path).toBe(unusedDir);
    db.close();
  });

  test("unused worktrees sort after workspaces with sessions in tree and picker", () => {
    const db = projectTreeDb();
    const insert = db.prepare(
      `INSERT INTO workspaces
       (id,project_id,name,path,kind,git_branch,created_by,created_at,last_used_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    insert.run("unused", "p", "unused", unusedDir, "worktree", "unused", "worktree-scan", 999, 999);
    insert.run("active", "p", "active", activeDir, "worktree", "active", "discovered", 1, null);
    db.prepare("INSERT INTO sessions VALUES ('s','active',10,0,'user')").run();

    expect(clearScanRegistrationRecency(db)).toBe(1);
    expect(clearScanRegistrationRecency(db)).toBe(0);
    expect(listProjectTree(db)[0]?.workspaces.map((w) => w.id)).toEqual([
      "active",
      "unused",
    ]);

    const pickerRows = sortRecentWorkspaces([
      { path: unusedDir, shortName: "unused", lastUsedAt: 0, source: "trellis" },
      { path: activeDir, shortName: "active", lastUsedAt: 10, source: "trellis" },
    ]);
    expect(pickerRows.map((w) => w.shortName)).toEqual(["active", "unused"]);
    db.close();
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
