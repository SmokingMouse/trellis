import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitMarkerKind, isDeployedDb, prodDbGuardError } from "./prod-db-guard";

// 三种目录形态：链接 worktree（.git 是文件）、主 checkout（.git 是目录）、发布目录（没有 .git）。
let root: string;
let worktree: string;
let mainCheckout: string;
let release: string;
let prodDb: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "prod-db-guard-"));
  worktree = path.join(root, "trellis-feature");
  mainCheckout = path.join(root, "trellis");
  release = path.join(root, "home", ".trellis", "releases", "20261030T000000-abc");
  fs.mkdirSync(path.join(worktree, "lib", "server"), { recursive: true });
  fs.writeFileSync(path.join(worktree, ".git"), "gitdir: ../trellis/.git/worktrees/x\n");
  fs.mkdirSync(path.join(mainCheckout, ".git"), { recursive: true });
  fs.mkdirSync(release, { recursive: true });
  fs.symlinkSync(release, path.join(root, "home", ".trellis", "current"));
  prodDb = path.join(root, "home", ".trellis", "data.db");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const base = () => ({
  explicitDbPath: undefined as string | undefined,
  allowFlag: undefined as string | undefined,
  dbPath: prodDb,
  dbIsDeployed: true,
});

describe("gitMarkerKind", () => {
  test("认得出链接 worktree、主 checkout 和没有 git 的目录", () => {
    expect(gitMarkerKind(path.join(worktree, "lib", "server"))).toBe("file");
    expect(gitMarkerKind(mainCheckout)).toBe("dir");
    expect(gitMarkerKind(release)).toBeNull();
  });
});

describe("prodDbGuardError", () => {
  test("worktree 里的进程不带 TRELLIS_DB_PATH 打开 prod 库 → 拒绝，并告诉人怎么办", () => {
    const err = prodDbGuardError({ ...base(), dirs: [worktree] });
    expect(err).toContain("TRELLIS_DB_PATH");
    expect(err).toContain("TRELLIS_ALLOW_PROD_DB=1");
  });

  test("代码在 worktree、工作目录在主 checkout（bun -e 跨目录 import）也拦", () => {
    expect(prodDbGuardError({ ...base(), dirs: [mainCheckout, path.join(worktree, "lib", "server")] })).not.toBeNull();
  });

  test("发布目录、主 checkout 照旧放行", () => {
    expect(prodDbGuardError({ ...base(), dirs: [release] })).toBeNull();
    expect(prodDbGuardError({ ...base(), dirs: [mainCheckout] })).toBeNull();
  });

  test("显式 TRELLIS_DB_PATH 或 TRELLIS_ALLOW_PROD_DB=1 放行", () => {
    expect(prodDbGuardError({ ...base(), dirs: [worktree], explicitDbPath: "/tmp/copy.db" })).toBeNull();
    expect(prodDbGuardError({ ...base(), dirs: [worktree], allowFlag: "1" })).toBeNull();
  });

  test("只覆盖了 HOME 的隔离实例：默认库落在临时目录，不是 prod 库，放行", () => {
    const tmpDb = path.join(root, "isolated-home", ".trellis", "data.db");
    expect(isDeployedDb(tmpDb)).toBe(false);
    expect(prodDbGuardError({ ...base(), dirs: [worktree], dbPath: tmpDb, dbIsDeployed: false })).toBeNull();
  });

  test("测试进程在主 checkout 里也不许碰 prod 库；临时库照旧", () => {
    expect(prodDbGuardError({ ...base(), dirs: [mainCheckout], isTest: true })).toContain("TRELLIS_DB_PATH");
    expect(prodDbGuardError({ ...base(), dirs: [release], isTest: true })).not.toBeNull();
    expect(prodDbGuardError({ ...base(), dirs: [mainCheckout], isTest: true, dbIsDeployed: false })).toBeNull();
    expect(prodDbGuardError({ ...base(), dirs: [mainCheckout], isTest: true, explicitDbPath: "/tmp/t.db" })).toBeNull();
  });

  test("isDeployedDb 认 deploy.ts 的发布布局（current / releases）", () => {
    expect(isDeployedDb(prodDb)).toBe(true);
  });
});
