import { afterAll, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

mock.module("server-only", () => ({}));

const root = mkdtempSync("/tmp/trellis-worktree-clean-");
const {
  activeWorkspaceSessionCount,
  isDefaultCleanCandidate,
  pruneWorktreeMetadata,
  resolveMainCheckoutPath,
} = await import("./worktree-clean");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Trellis Test",
      GIT_AUTHOR_EMAIL: "trellis@example.test",
      GIT_COMMITTER_NAME: "Trellis Test",
      GIT_COMMITTER_EMAIL: "trellis@example.test",
    },
  }).trim();
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("worktree cleanup helpers", () => {
  test("active count includes only unarchived user sessions", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE sessions (id TEXT, archived INTEGER, kind TEXT, workspace_id TEXT);
      INSERT INTO sessions VALUES
        ('active-user',0,'user','w'),
        ('active-task',0,'task','w'),
        ('archived-user',1,'user','w');
    `);
    expect(activeWorkspaceSessionCount(db, "w")).toBe(1);
    db.close();
  });

  test("clean count excludes worktrees with active user sessions", () => {
    const clean = {
      canClean: true,
      dirtyCount: 0,
      ignoredCount: 0,
      sessionCount: 0,
    };
    expect(isDefaultCleanCandidate(clean)).toBeTrue();
    expect(isDefaultCleanCandidate({ ...clean, sessionCount: 1 })).toBeFalse();
  });

  test("prune runs from the surviving main checkout", () => {
    const repo = path.join(root, "repo");
    const stale = path.join(root, "stale");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(repo, "add", "base.txt");
    git(repo, "commit", "-qm", "base");
    git(repo, "worktree", "add", "-q", "-b", "stale", stale);
    rmSync(stale, { recursive: true, force: true });

    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE workspaces (
        id TEXT, project_id TEXT, path TEXT, kind TEXT, created_at INTEGER
      );
    `);
    db.prepare("INSERT INTO workspaces VALUES ('main','p',?,'main',1)").run(repo);
    const main = resolveMainCheckoutPath(db, "p", stale);
    expect(main).toBe(repo);
    pruneWorktreeMetadata(main!);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(stale);
    db.close();
  });
});
