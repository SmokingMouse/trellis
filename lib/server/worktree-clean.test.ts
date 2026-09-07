import { afterAll, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

mock.module("server-only", () => ({}));

const root = mkdtempSync("/tmp/trellis-worktree-clean-");
const {
  activeWorkspaceSessionCount,
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
  test("active count excludes archived sessions", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE sessions (id TEXT, archived INTEGER, workspace_id TEXT);
      INSERT INTO sessions VALUES ('active',0,'w'), ('archived',1,'w');
    `);
    expect(activeWorkspaceSessionCount(db, "w")).toBe(1);
    db.close();
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
