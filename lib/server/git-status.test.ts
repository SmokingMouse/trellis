import { afterAll, describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

mock.module("server-only", () => ({}));

const root = mkdtempSync("/tmp/trellis-git-status-");
let repoSeq = 0;

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

function initRepo(): string {
  const repo = path.join(root, `repo-${repoSeq++}`);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-qm", "base");
  return repo;
}

function commitFile(repo: string, name: string): string {
  writeFileSync(path.join(repo, `${name}.txt`), `${name}\n`);
  git(repo, "add", `${name}.txt`);
  git(repo, "commit", "-qm", name);
  return git(repo, "rev-parse", "HEAD");
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("isMergedInto", () => {
  test("does not mark a zero-commit branch merged after main gains a merge commit", async () => {
    const repo = initRepo();
    git(repo, "branch", "zero");
    const zeroTip = git(repo, "rev-parse", "zero");
    git(repo, "checkout", "-qb", "feature");
    commitFile(repo, "feature");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");

    expect(await isMergedInto(repo, zeroTip, "main")).toBeFalse();
  });

  test("does not mark a main-history tip merged through an update-branch second parent", async () => {
    const repo = initRepo();
    git(repo, "checkout", "-qb", "pull-request");
    commitFile(repo, "pull-request");
    git(repo, "checkout", "-q", "main");
    const zeroTip = commitFile(repo, "main-update");
    git(repo, "branch", "zero", zeroTip);
    git(repo, "checkout", "-q", "pull-request");
    git(repo, "merge", "-q", "--no-ff", "-m", "update branch", "main");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--no-ff", "-m", "merge pull request", "pull-request");

    expect(await isMergedInto(repo, zeroTip, "main")).toBeFalse();
  });

  test("recognizes a true --no-ff topic after main advances again", async () => {
    const repo = initRepo();
    git(repo, "checkout", "-qb", "feature");
    const mergedTip = commitFile(repo, "feature");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");
    expect(await isMergedInto(repo, mergedTip, "main")).toBeTrue();
    commitFile(repo, "main-after-merge");
    expect(await isMergedInto(repo, mergedTip, "main")).toBeTrue();
  });

  test("deliberately does not recognize squash merges because the topic tip is absent", async () => {
    const repo = initRepo();
    git(repo, "checkout", "-qb", "squash-feature");
    const squashTip = commitFile(repo, "squash-feature");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--squash", "squash-feature");
    git(repo, "commit", "-qm", "squash merge feature");

    expect(await isMergedInto(repo, squashTip, "main")).toBeFalse();
  });

  test("deliberately does not recognize a rebase-style fast-forward", async () => {
    const repo = initRepo();
    git(repo, "checkout", "-qb", "rebased-feature");
    const rebasedTip = commitFile(repo, "rebased-feature");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--ff-only", "rebased-feature");

    expect(await isMergedInto(repo, rebasedTip, "main")).toBeFalse();
  });

  test("does not recognize a branch that merges main and is then fast-forwarded", async () => {
    const repo = initRepo();
    git(repo, "checkout", "-qb", "feature");
    commitFile(repo, "feature");
    git(repo, "checkout", "-q", "main");
    commitFile(repo, "main-update");
    git(repo, "checkout", "-q", "feature");
    git(repo, "merge", "-q", "--no-ff", "-m", "merge main", "main");
    const featureTip = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--ff-only", "feature");

    expect(await isMergedInto(repo, featureTip, "main")).toBeFalse();
  });
});
