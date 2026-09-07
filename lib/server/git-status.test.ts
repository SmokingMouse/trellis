import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

mock.module("server-only", () => ({}));

const root = mkdtempSync("/tmp/trellis-git-status-");
const repo = path.join(root, "repo");
const zeroWorktree = path.join(root, "zero-worktree");
let zeroTip = "";
let mergedTip = "";
let squashTip = "";

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

const { isMergedInto } = await import("./git-status");

beforeAll(() => {
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-qm", "base");

  git(repo, "branch", "zero");
  zeroTip = git(repo, "rev-parse", "zero");
  git(repo, "worktree", "add", "-q", zeroWorktree, "zero");

  git(repo, "checkout", "-qb", "merged-feature");
  writeFileSync(path.join(repo, "merged.txt"), "merged\n");
  git(repo, "add", "merged.txt");
  git(repo, "commit", "-qm", "merged feature");
  mergedTip = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge feature", "merged-feature");

  git(repo, "checkout", "-qb", "squash-feature");
  writeFileSync(path.join(repo, "squash.txt"), "squash\n");
  git(repo, "add", "squash.txt");
  git(repo, "commit", "-qm", "squash feature");
  squashTip = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--squash", "squash-feature");
  git(repo, "commit", "-qm", "squash merge feature");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("isMergedInto", () => {
  test("does not mark a zero-commit worktree merged after main gains a merge commit", async () => {
    expect(await isMergedInto(zeroWorktree, zeroTip, "main")).toBeFalse();
  });

  test("recognizes the topic parent of a true --no-ff merge", async () => {
    expect(await isMergedInto(repo, mergedTip, "main")).toBeTrue();
  });

  test("deliberately does not recognize squash merges because the topic tip is absent", async () => {
    expect(await isMergedInto(repo, squashTip, "main")).toBeFalse();
  });
});
