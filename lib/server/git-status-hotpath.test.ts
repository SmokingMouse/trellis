// 根因 E 的回归：侧栏 git 角标接口 `GET /api/workspaces/git-status` 不再把
// worktree 重扫挂在每一次请求上。
//
// 现场（BOE devbox n37-109-213）：48 条 workspace 路径全指向同一个上百 worktree
// 的大仓，每次 GET 都无条件 `rescanWorktrees()` → 对每条 distinct path 各跑一次
// `git worktree list --porcelain` 的 **spawnSync**。结果：next 进程 rchar
// 172MB/s、30 分钟 646GB，同一个 gitdir 在一次请求里被 stat 48 次，git 子进程
// 3.6 个/秒，事件循环被占满，/login 从 ~5ms 掉到 2–10s。
//
// 这里造一个 24 个 worktree 的临时仓 + 把 25 条路径（主 checkout + 24 个
// worktree）全塞进 workspaces 表，复现 N×M 的形状，然后钉死四条判据：
//   1. 连打 20 次接口，git 子进程总数有明确上界，且第 2 次起**一个都不再起**；
//   2. 请求路径上 spawnSync 调用数 = 0；
//   3. 每个 git 子进程人为慢 150ms 的情况下，事件循环单次阻塞 < 100ms；
//   4. 后台重扫按 repo 去重（25 条路径 → 1 次 git）、mtime 没变时直接短路，
//      而新建的 worktree 仍会在声明的延迟上界内出现（产品意图不回退）。
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

mock.module("server-only", () => ({}));

// ── spawnSync 计数桩 ────────────────────────────────────────────────
// 必须先于被测模块 import：project-cluster.ts 在模块顶层就绑定了 spawnSync。
const childProcess = await import("node:child_process");
const originalChildProcess = { ...childProcess };
const realSpawnSync = childProcess.spawnSync;
let spawnSyncCalls = 0;
mock.module("node:child_process", () => ({
  ...originalChildProcess,
  default: originalChildProcess.default ?? originalChildProcess,
  spawnSync: (...args: Parameters<typeof realSpawnSync>) => {
    spawnSyncCalls++;
    return realSpawnSync(...args);
  },
}));

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], {
  encoding: "utf8",
}).trim();

const root = fs.realpathSync(fs.mkdtempSync("/tmp/trellis-gitstatus-hot-"));
const repo = path.join(root, "repo");
const shimDir = path.join(root, "bin");
const gitLog = path.join(root, "git-calls.log");
const WORKTREES = 24;

const originalPath = process.env.PATH;
const originalDbPath = process.env.TRELLIS_DB_PATH;
const originalRescanMs = process.env.TRELLIS_WORKTREE_RESCAN_MS;

process.env.TRELLIS_DB_PATH = path.join(root, "data.db");
// 后台定时器周期。测试里不靠它推进（用 triggerWorktreeRescan 手动驱动），
// 设成很长只是为了让 ensureWorktreeRescanScheduled 不在 20 连打期间插进来。
process.env.TRELLIS_WORKTREE_RESCAN_MS = "3600000";

const { resetDBForTests, getDB } = await import("./sqlite");
const { invalidateGitStatus } = await import("./git-status");
const {
  observeWorktreeRescan,
  stopWorktreeRescan,
  triggerWorktreeRescan,
} = await import("./workspaces");
const { GET } = await import("../../app/api/workspaces/git-status/route");

function git(cwd: string, ...args: string[]): string {
  return execFileSync(REAL_GIT, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: originalPath, // 造夹具时绕开计数 shim
      GIT_AUTHOR_NAME: "Trellis Test",
      GIT_AUTHOR_EMAIL: "trellis@example.test",
      GIT_COMMITTER_NAME: "Trellis Test",
      GIT_COMMITTER_EMAIL: "trellis@example.test",
    },
  }).trim();
}

/** 计数 shim 记下的 git 子进程调用数。 */
function gitCalls(): number {
  try {
    return fs.readFileSync(gitLog, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function resetGitCalls(): void {
  fs.writeFileSync(gitLog, "");
}

/** 1ms 定时器打点：相邻两次回调的间隔就是那一刻事件循环被占用的时长。 */
function startLagProbe() {
  let max = 0;
  let last = performance.now();
  let stopped = false;
  const tick = () => {
    const now = performance.now();
    const lag = now - last - 1;
    if (lag > max) max = lag;
    last = now;
    if (!stopped) setTimeout(tick, 1);
  };
  setTimeout(tick, 1);
  return () => {
    stopped = true;
    return max;
  };
}

type RescanReport = {
  added: number;
  pruned: number;
  skipped: boolean;
  generation: number;
};

async function getStatuses(): Promise<{
  statuses: unknown[];
  rescan: RescanReport;
}> {
  const res = await GET();
  return (await res.json()) as { statuses: unknown[]; rescan: RescanReport };
}

function registerWorkspace(p: string, kind: "main" | "worktree"): void {
  getDB()
    .prepare(
      `INSERT INTO workspaces
         (id, project_id, name, path, kind, git_branch, created_by, created_at, last_used_at)
       VALUES (?, 'hotpath-project', ?, ?, ?, NULL, 'worktree-scan', ?, NULL)`,
    )
    .run(`ws-${path.basename(p)}`, path.basename(p), p, kind, Date.now());
}

beforeAll(() => {
  // ── 夹具仓：主 checkout + 24 个 linked worktree ──
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-qm", "base");
  for (let i = 0; i < WORKTREES; i++) {
    git(repo, "worktree", "add", "-q", "-b", `wt-${i}`, path.join(root, `wt-${i}`));
  }

  // ── 计数 shim：记一行再 exec 真 git；TRELLIS_TEST_GIT_SLEEP 能让它变慢 ──
  fs.mkdirSync(shimDir);
  const shim = path.join(shimDir, "git");
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${gitLog}"\n` +
      `if [ -n "$TRELLIS_TEST_GIT_SLEEP" ]; then sleep "$TRELLIS_TEST_GIT_SLEEP"; fi\n` +
      `exec ${REAL_GIT} "$@"\n`,
  );
  fs.chmodSync(shim, 0o755);
  resetGitCalls();
  process.env.PATH = `${shimDir}:${originalPath}`;

  // ── DB：一个 project + 25 条路径，全指向同一个 repo（devbox 的形状）──
  resetDBForTests();
  const db = getDB();
  db.prepare(
    `INSERT INTO projects (id, name, cluster_key, git_remote, created_at, updated_at)
     VALUES ('hotpath-project', 'hotpath', 'gitdir:${path.join(repo, ".git")}', NULL, ?, ?)`,
  ).run(Date.now(), Date.now());
  registerWorkspace(repo, "main");
  for (let i = 0; i < WORKTREES; i++) {
    registerWorkspace(path.join(root, `wt-${i}`), "worktree");
  }
});

afterAll(() => {
  stopWorktreeRescan();
  resetDBForTests();
  process.env.PATH = originalPath;
  if (originalDbPath === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = originalDbPath;
  if (originalRescanMs === undefined)
    delete process.env.TRELLIS_WORKTREE_RESCAN_MS;
  else process.env.TRELLIS_WORKTREE_RESCAN_MS = originalRescanMs;
  mock.module("node:child_process", () => originalChildProcess);
  fs.rmSync(root, { recursive: true, force: true });
});

test(
  "连打 20 次角标接口：git 子进程有上界、第 2 次起零 spawn、请求路径无 spawnSync、事件循环不被占住",
  async () => {
    invalidateGitStatus();
    stopWorktreeRescan();
    resetGitCalls();
    spawnSyncCalls = 0;
    // 每个 git 子进程慢 150ms。这一条同时是「请求路径上没有同步 spawn」的
    // 直接证据：只要还有一次 spawnSync，事件循环就至少被钉住 150ms。
    process.env.TRELLIS_TEST_GIT_SLEEP = "0.15";

    const N = 20;
    const stop = startLagProbe();
    await Bun.sleep(20);

    const first = await getStatuses();
    const afterFirst = gitCalls();
    for (let i = 1; i < N; i++) await getStatuses();
    const afterAllReqs = gitCalls();

    await Bun.sleep(20);
    const maxLag = stop();
    delete process.env.TRELLIS_TEST_GIT_SLEEP;

    const rows = WORKTREES + 1;
    console.log(
      `[git-status] ${rows} 条 workspace × ${N} 次请求：` +
        `git 子进程 ${afterAllReqs}（首次 ${afterFirst}，第 2–${N} 次 ${afterAllReqs - afterFirst}）；` +
        `spawnSync ${spawnSyncCalls}；事件循环最大阻塞 ${maxLag.toFixed(1)}ms`,
    );

    expect(first.statuses.length).toBe(rows);
    // 改前：每次请求都要 25 次 `git worktree list` 的同步 spawn，20 次 = 500，
    // 角标本身的 git 调用还要另算。这里的上界只跟「行数 × 每行的状态查询」
    // 挂钩，与请求次数无关。
    expect(afterAllReqs).toBeLessThanOrEqual(rows * 8);
    // 第 2 次及以后：TTL 缓存全命中 + 不重扫 ⇒ 一个 git 子进程都不起。
    expect(afterAllReqs).toBe(afterFirst);
    // 请求路径上不得有同步 spawn。
    expect(spawnSyncCalls).toBe(0);
    expect(maxLag).toBeLessThan(100);
  },
  180_000,
);

test("重扫按 repo 去重：25 条同仓路径只跑一次 git worktree list", async () => {
  stopWorktreeRescan();
  resetGitCalls();
  await triggerWorktreeRescan(getDB());
  const firstScan = gitCalls();

  // 第二轮：`.git/worktrees` 的 mtime 没变 → 直接复用上一轮结果，零子进程。
  resetGitCalls();
  await triggerWorktreeRescan(getDB());
  const secondScan = gitCalls();

  console.log(
    `[git-status] 后台重扫：首轮 ${firstScan} 个 git 子进程，mtime 未变的第二轮 ${secondScan} 个`,
  );
  // 25 条路径折成 1 个 repo ⇒ 1 次 `git worktree list`。所有路径都已登记，
  // 所以登记环节不会再走 clusterPath 的同步 git。
  expect(firstScan).toBe(1);
  expect(secondScan).toBe(0);
});

test("CLI 里新建的 worktree 仍会被后台重扫发现（产品意图不回退）", async () => {
  stopWorktreeRescan();
  // observeWorktreeRescan 会顺手起一轮即时扫描 —— 先把它等干净，
  // 否则「变化前起的那一轮」会把 mtime 基线读成旧值。
  const before = observeWorktreeRescan().generation;
  await triggerWorktreeRescan(getDB());

  const fresh = path.join(root, "wt-fresh");
  git(repo, "worktree", "add", "-q", "-b", "wt-fresh", fresh);

  await triggerWorktreeRescan(getDB());

  const row = getDB()
    .prepare("SELECT kind, created_by FROM workspaces WHERE path = ?")
    .get(fresh) as { kind: string; created_by: string } | undefined;
  expect(row?.kind).toBe("worktree");
  expect(row?.created_by).toBe("worktree-scan");

  const report = observeWorktreeRescan();
  expect(report.added).toBeGreaterThanOrEqual(1);
  expect(report.generation).toBeGreaterThan(before);
  // 请求路径自己永远不重扫 —— 它只读后台的账。
  expect(report.skipped).toBe(true);
});

test("扫描进行中发生的变化会被补扫看见（不会因为折叠并发而永久漏掉）", async () => {
  stopWorktreeRescan();
  await triggerWorktreeRescan(getDB()); // 建立 mtime 基线

  // 先起一轮（不 await），它读到的是变化**之前**的 mtime。
  const running = triggerWorktreeRescan(getDB());
  const fresh = path.join(root, "wt-inflight");
  git(repo, "worktree", "add", "-q", "-b", "wt-inflight", fresh);
  // 此刻再触发：不能折进 running，必须排一轮补扫。
  const followUp = triggerWorktreeRescan(getDB());
  await running;
  await followUp;

  expect(
    getDB().prepare("SELECT 1 FROM workspaces WHERE path = ?").get(fresh),
  ).not.toBeNull();
});

test("角标接口在重扫从未跑过时也不报错，rescan 明说本次没扫", async () => {
  stopWorktreeRescan();
  invalidateGitStatus();
  const { rescan, statuses } = await getStatuses();
  expect(rescan.skipped).toBe(true);
  expect(rescan.added).toBe(0);
  expect(rescan.pruned).toBe(0);
  expect(rescan.generation).toBe(0);
  expect(statuses.length).toBeGreaterThan(0);
  // getStatuses 顺手起的那一轮后台扫描要等干净，别让它撞上 afterAll 关库。
  await triggerWorktreeRescan(getDB());
});
