#!/usr/bin/env bun
// trellis 部署流水线（S79）。`make deploy`。
//
// 它替换掉的旧做法：在 launchd 正在跑的那个目录里原地 `bun install` +
// `make build` + `launchctl kickstart -k`。那套的问题不是麻烦，是**不可逆**——
// `next build` 直接改运行中的 `.next`，build 失败就地把 prod 打成半死；build
// 成功却忘了 kickstart，就是「内存里旧模块 + 磁盘上新文件」混跑（S66 实测：
// 页面能开但交互全挂）。而且没有回滚路径。
//
// 新做法就一句话：**新版本先在别处建好、证明能启动，再花十秒切过去；切坏了
// 自己滚回来。** 目录布局见 lib/deploy-state.ts。
//
//   bun scripts/deploy.ts [ref] [--force]     部署（默认 HEAD）
//   bun scripts/deploy.ts rollback            切回上一个 release
//   bun scripts/deploy.ts status              当前状态
//   bun scripts/deploy.ts releases            列出 release
//   bun scripts/deploy.ts install-launchd     把 launchd 指向 <root>/current
//
// 环境变量：TRELLIS_DEPLOY_ROOT（产物根，演练用）/ TRELLIS_DEPLOY_LABEL /
// TRELLIS_DEPLOY_PORT（网关端口，验活用）。

import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deployPaths,
  readDeployState,
  writeDeployState,
  type DeployPhase,
  type DeployState,
} from "../lib/deploy-state";

const P = deployPaths();
const LABEL = process.env.TRELLIS_DEPLOY_LABEL || "com.smokingmouse.trellis";
const GATE_PORT = Number(process.env.TRELLIS_DEPLOY_PORT) || 3088;
const REPO = process.cwd();
const PROD_DB =
  process.env.TRELLIS_DB_PATH || path.join(os.homedir(), ".trellis", "data.db");

// ── 日志 ───────────────────────────────────────────────────────────────────
let logFile: string | null = null;

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + "\n");
    } catch {
      /* 日志写不进去不该拦着部署 */
    }
  }
}

let state: DeployState = {
  phase: "idle",
  sha: null,
  previousSha: null,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  message: "",
  logFile: null,
};

function phase(p: DeployPhase, message: string): void {
  state = { ...state, phase: p, message, updatedAt: new Date().toISOString() };
  writeDeployState(state);
  log(`── ${p}: ${message}`);
}

// ── 小工具 ─────────────────────────────────────────────────────────────────
type RunResult = { code: number; stdout: string; stderr: string };

async function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string>; quiet?: boolean } = {},
): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd ?? REPO,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (!opts.quiet && (stdout.trim() || stderr.trim())) {
    for (const line of `${stdout}${stderr}`.trimEnd().split("\n")) {
      if (line.trim()) log(`   │ ${line}`);
    }
  }
  return { code, stdout, stderr };
}

async function mustRun(cmd: string[], opts?: Parameters<typeof run>[1]) {
  const r = await run(cmd, opts);
  if (r.code !== 0) {
    throw new Error(`命令失败（exit ${r.code}）：${cmd.join(" ")}`);
  }
  return r;
}

async function httpGet(
  url: string,
  timeoutMs = 5000,
): Promise<{ status: number; body: string } | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, body: await r.text() };
  } catch {
    return null;
  }
}

/** prod ttyd 的 pid 集合。smoke 前后各取一次，用来证明没误杀。 */
async function ttydPids(): Promise<string[]> {
  const r = await run(["pgrep", "-f", "ttyd .*titleFixed trellis"], {
    quiet: true,
  });
  return r.stdout.trim().split("\n").filter(Boolean).sort();
}

function symlinkTarget(link: string): string | null {
  try {
    return fs.readlinkSync(link);
  } catch {
    return null;
  }
}

/** 原子换 symlink：先建临时链接再 rename(2)。`ln -sfn` 覆盖已存在的链接不是原子的。 */
function atomicSymlink(target: string, link: string): void {
  const tmp = `${link}.tmp-${process.pid}`;
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* 本来就没有 */
  }
  fs.symlinkSync(target, tmp);
  fs.renameSync(tmp, link);
}

async function kickstart(): Promise<void> {
  await run(["launchctl", "kickstart", "-k", `gui/${process.getuid?.()}/${LABEL}`]);
}

// ── 阶段 ───────────────────────────────────────────────────────────────────

/**
 * 只读地问一句「现在有没有人正在跑对话」。
 *
 * **必须 readonly 打开，且绝不能走 lib/server/sqlite.ts 的 getDB()**：
 * 那边的 migrate() 里藏着一段「把所有 status='streaming' 的节点判成 error」的
 * 收尸逻辑（sqlite.ts:531），而 migrate() 是每进程首次打开数据库就跑。用错姿势
 * 的话，部署脚本自己就把用户正在跑的对话全部弄死了。
 */
function activeRuns(): { id: string; sessionId: string }[] {
  if (!fs.existsSync(PROD_DB)) return [];
  const db = new Database(PROD_DB, { readonly: true });
  try {
    return db
      .query("SELECT id, session_id AS sessionId FROM nodes WHERE status = 'streaming'")
      .all() as { id: string; sessionId: string }[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

async function preflight(ref: string, force: boolean): Promise<{ sha: string; short: string }> {
  phase("preflight", `解析 ${ref}`);

  const rev = await run(["git", "rev-parse", "--verify", `${ref}^{commit}`], {
    quiet: true,
  });
  if (rev.code !== 0) throw new Error(`解析不了 ref：${ref}`);
  const sha = rev.stdout.trim();
  const short = sha.slice(0, 9);
  state.sha = short;

  // 只部署已提交的 sha —— git archive 的天然约束，也是「出事能回到一个确定
  // 状态」的前提。工作区脏不阻塞（脏东西本来就不会进 release），只提醒。
  const dirty = await run(["git", "status", "--porcelain"], { quiet: true });
  if (dirty.stdout.trim()) {
    log(`   ! 工作区有未提交改动，它们不会进本次 release（部署的是 ${short}）`);
  }

  const running = activeRuns();
  if (running.length > 0) {
    log(`   ! 有 ${running.length} 个会话正在生成：`);
    for (const r of running.slice(0, 10)) log(`     - node ${r.id} (session ${r.sessionId})`);
    if (!force) {
      throw new Error(
        "有正在跑的对话，切换会把它们全部中断。等它们跑完，或加 --force 强切。",
      );
    }
    log("   ! --force：无视活跃会话继续");
  }

  log(`   目标 ${short}`);
  return { sha, short };
}

async function stage(sha: string, short: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const dir = path.join(P.releases, `${stamp}-${short}`);
  phase("stage", `导出到 ${dir}`);

  fs.mkdirSync(dir, { recursive: true });
  // git archive 而不是 clone/worktree：拿到的是干净的源码树，不带 .git、
  // 不往主仓的 worktree 注册表里塞东西。
  const tar = path.join(P.releases, `.${stamp}.tar`);
  await mustRun(["git", "archive", "--format=tar", "-o", tar, sha]);
  await mustRun(["tar", "-xf", tar, "-C", dir]);
  fs.unlinkSync(tar);

  const ref = (await run(["git", "log", "-1", "--pretty=%s", sha], { quiet: true }))
    .stdout.trim();
  fs.writeFileSync(
    path.join(dir, "RELEASE.json"),
    JSON.stringify({ sha: short, ref, builtAt: new Date().toISOString() }, null, 2),
  );
  return dir;
}

async function install(dir: string): Promise<void> {
  phase("install", "bun install");
  // bun 默认就是从全局 cache 硬链接进 node_modules，所以每个 release 各装一份
  // 并不会真的各占一份磁盘，也不慢。不做跨 release 复制那类小聪明。
  await mustRun(["bun", "install", "--frozen-lockfile"], { cwd: dir });
}

async function build(dir: string): Promise<void> {
  phase("build", "next build（prod 全程不受影响）");
  await mustRun(["bun", "--bun", "run", "build"], { cwd: dir });
}

async function smoke(dir: string): Promise<void> {
  phase("smoke", "起临时实例验证新版本真的能跑");

  const smokeDb = path.join(dir, "smoke.db");
  // 用**真数据的一致性快照**而不是空库 —— 这样顺带验证 migrate() 吃得下现网
  // 数据，而不只是验证「代码能启动」。
  if (fs.existsSync(PROD_DB)) {
    const db = new Database(PROD_DB);
    try {
      db.exec(`VACUUM INTO '${smokeDb.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
    log("   已从 prod DB 生成快照 smoke.db");
  }

  const gatePort = 3990 + Math.floor(Math.random() * 8);
  const ttydBefore = await ttydPids();

  const env: Record<string, string> = {
    ...process.env,
    TRELLIS_DB_PATH: smokeDb,
    TRELLIS_NEXT_PORT: String(gatePort + 100),
    TRELLIS_TTYD_PORT: String(7900 + (gatePort % 20)),
    NODE_ENV: "production",
  };
  // 关掉认证闸，否则每个断言都要先登录。
  delete env.TRELLIS_AUTH_PASS;
  delete env.TRELLIS_AUTH_TOKEN;

  const proc = Bun.spawn(
    ["bun", "--bun", "run", "start", "--", "-p", String(gatePort)],
    { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
  );

  // 边跑边收管道。攒到最后再读会死锁：Next 启动期就能写满 64KB 管道缓冲，
  // 而那时我们正卡在 90s 的健康轮询里，谁也不动。
  const tail: string[] = [];
  const drain = async (s: ReadableStream<Uint8Array> | undefined) => {
    if (!s) return;
    const reader = s.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      for (const l of dec.decode(value).split("\n")) {
        if (!l.trim()) continue;
        tail.push(l);
        if (tail.length > 200) tail.shift();
      }
    }
  };
  void drain(proc.stdout as ReadableStream<Uint8Array>);
  void drain(proc.stderr as ReadableStream<Uint8Array>);

  const kill = async () => {
    try {
      proc.kill();
    } catch {
      /* 已经没了 */
    }
    await Promise.race([proc.exited, Bun.sleep(8000)]);
  };

  try {
    const deadline = Date.now() + 90_000;
    let up = false;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) break;
      // 就绪判据要与版本无关 —— 部署一个早于 /__gate/health 的版本（比如按
      // sha 回滚）时，那条接口是 404，不能因此判它没起来。/login 是自古就有
      // 且不需要认证的那一条。
      const h = await httpGet(`http://127.0.0.1:${gatePort}/__gate/health`, 2000);
      if (h?.status === 200) {
        try {
          if (JSON.parse(h.body).next === "ready") {
            up = true;
            break;
          }
        } catch {
          /* 不是 JSON，落到 /login 判据 */
        }
      }
      const l = await httpGet(`http://127.0.0.1:${gatePort}/login`, 2000);
      if (l?.status === 200) {
        up = true;
        break;
      }
      await Bun.sleep(500);
    }
    if (!up) {
      log(`   × 新版本 90s 内没起来。输出尾部：`);
      for (const l of tail.slice(-25)) log(`   │ ${l}`);
      throw new Error("smoke 失败：新版本起不来");
    }

    const checks: [string, (r: { status: number; body: string }) => boolean][] = [
      ["/login", (r) => r.status === 200],
      ["/", (r) => r.status === 200],
      [
        "/api/providers",
        (r) => {
          if (r.status !== 200) return false;
          const d = JSON.parse(r.body);
          const n = Array.isArray(d) ? d.length : Array.isArray(d?.providers) ? d.providers.length : 0;
          return n > 0;
        },
      ],
      ["/api/sessions", (r) => r.status === 200],
    ];
    for (const [p, ok] of checks) {
      const r = await httpGet(`http://127.0.0.1:${gatePort}${p}`, 15_000);
      if (!r || !ok(r)) {
        throw new Error(`smoke 失败：${p} → ${r ? r.status : "无响应"}`);
      }
      log(`   ✓ ${p}`);
    }
  } finally {
    await kill();
  }

  // 回归断言：smoke 实例不许碰 prod 的终端。这条曾经是坏的 —— reapOrphans
  // 按 ppid==1 判孤儿，而 prod 正在服务的 ttyd 恰恰就是 ppid 1，于是每起一个
  // 隔离实例都会把用户的终端杀掉（见 lib/server/ttyd.ts 的长注释）。
  const ttydAfter = await ttydPids();
  const killed = ttydBefore.filter((p) => !ttydAfter.includes(p));
  if (killed.length > 0) {
    throw new Error(
      `smoke 实例杀掉了 prod 的 ttyd（pid ${killed.join(",")}）—— reapOrphans 判据又坏了`,
    );
  }
  log(`   ✓ prod ttyd 未受影响（${ttydBefore.length} 个进程原样存活）`);
}

function backup(): void {
  if (!fs.existsSync(PROD_DB)) return;
  phase("backup", "数据库快照");
  fs.mkdirSync(P.backups, { recursive: true });
  const out = path.join(
    P.backups,
    `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}.db`,
  );
  const db = new Database(PROD_DB);
  try {
    // VACUUM INTO 给的是一致性快照，不受 WAL 里有没有未 checkpoint 的事务影响。
    db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  log(`   ${out}`);

  // 留 5 份就够 —— 迁移全是加法 DDL，回滚主要靠 release 而不是靠库。
  const olds = fs
    .readdirSync(P.backups)
    .filter((f) => f.endsWith(".db"))
    .sort()
    .slice(0, -5);
  for (const f of olds) fs.unlinkSync(path.join(P.backups, f));
}

async function switchTo(dir: string): Promise<void> {
  phase("switch", `current → ${path.basename(dir)}`);
  const prev = symlinkTarget(P.current);
  if (prev && prev !== dir) {
    atomicSymlink(prev, P.previous);
    state.previousSha = path.basename(prev).split("-").slice(1).join("-");
  }
  atomicSymlink(dir, P.current);
  installRollbackScript();
  await kickstart();
}

async function verify(): Promise<boolean> {
  phase("verify", `轮询 127.0.0.1:${GATE_PORT}`);
  const deadline = Date.now() + 90_000;
  let sawGate = false;
  while (Date.now() < deadline) {
    const h = await httpGet(`http://127.0.0.1:${GATE_PORT}/__gate/health`, 2000);
    if (h?.status === 200) {
      sawGate = true;
      try {
        if (JSON.parse(h.body).next === "ready") {
          log("   ✓ /__gate/health next=ready");
          return true;
        }
      } catch {
        /* 不是 JSON，当没看见 */
      }
    }
    // 老网关没有 /__gate/health（第一次部署、或部署的是旧版本）。退回到
    // 「/login 出得来」这条底线判据，别把「健康检查接口还没上线」判成故障。
    if (!sawGate) {
      const l = await httpGet(`http://127.0.0.1:${GATE_PORT}/login`, 2000);
      if (l?.status === 200) {
        log("   ✓ /login 200（网关无 /__gate/health，按底线判据放行）");
        return true;
      }
    }
    await Bun.sleep(1000);
  }
  log("   × 90s 内没验活成功");
  return false;
}

async function rollback(): Promise<boolean> {
  const target = symlinkTarget(P.previous);
  if (!target || !fs.existsSync(target)) {
    log("   × 没有可回滚的 previous");
    return false;
  }
  phase("rollback", `current → ${path.basename(target)}`);
  atomicSymlink(target, P.current);
  await kickstart();
  return await verify();
}

function gc(): void {
  const keep = new Set(
    [symlinkTarget(P.current), symlinkTarget(P.previous)].filter(Boolean) as string[],
  );
  let dirs: string[];
  try {
    dirs = fs.readdirSync(P.releases).sort();
  } catch {
    return;
  }
  const victims = dirs
    .map((d) => path.join(P.releases, d))
    .filter((d) => !keep.has(d))
    .slice(0, -1); // 除 current/previous 外再留最近一个
  for (const d of victims) {
    fs.rmSync(d, { recursive: true, force: true });
    log(`   gc ${path.basename(d)}`);
  }
}

function installRollbackScript(): void {
  fs.mkdirSync(P.bin, { recursive: true });
  const f = path.join(P.bin, "rollback.sh");
  // 刻意自包含：出事的时候仓库可能正是坏的那个东西，回滚不该依赖它。
  fs.writeFileSync(
    f,
    `#!/bin/sh
# trellis 应急回滚。由 scripts/deploy.ts 生成，不依赖仓库、不依赖 bun。
set -eu
ROOT="${P.root}"
LABEL="${LABEL}"
[ -L "$ROOT/previous" ] || { echo "没有 previous，无法回滚"; exit 1; }
TARGET=$(readlink "$ROOT/previous")
[ -d "$TARGET" ] || { echo "previous 指向的目录不存在：$TARGET"; exit 1; }
ln -s "$TARGET" "$ROOT/current.tmp.$$"
mv -f "$ROOT/current.tmp.$$" "$ROOT/current"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "已回滚到 $TARGET"
`,
    { mode: 0o755 },
  );
}

// ── 命令 ───────────────────────────────────────────────────────────────────

async function cmdDeploy(ref: string, force: boolean): Promise<number> {
  fs.mkdirSync(P.logs, { recursive: true });
  logFile = path.join(
    P.logs,
    `deploy-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}.log`,
  );
  state.logFile = logFile;
  state.startedAt = new Date().toISOString();

  let dir: string | null = null;
  try {
    const { sha, short } = await preflight(ref, force);

    const wd = await launchdWorkingDirectory();
    if (wd && path.resolve(wd) !== path.resolve(P.current)) {
      log(`   ! launchd 的 WorkingDirectory 还是 ${wd}`);
      log(`   ! 本次切换不会真正生效 —— 部署完跑一次 make install-launchd`);
    }

    dir = await stage(sha, short);
    await install(dir);
    await build(dir);
    await smoke(dir);
    backup();
    await switchTo(dir);

    if (!(await verify())) {
      log("   验活失败，自动回滚");
      if (await rollback()) {
        phase("failed", `${short} 验活失败，已回滚到上一个版本`);
        return 1;
      }
      phase("broken", `${short} 验活失败且回滚未成功 —— 手工介入：${P.bin}/rollback.sh`);
      return 2;
    }

    gc();
    phase("done", `${short} 已上线`);
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`   × ${msg}`);
    // 失败发生在 switch 之前 = prod 从头到尾没被碰过，这正是整套设计的重点。
    phase("failed", msg);
    if (dir && symlinkTarget(P.current) !== dir) {
      log(`   prod 未受影响（current 仍是 ${symlinkTarget(P.current) ?? "未设置"}）`);
    }
    return 1;
  }
}

async function launchdWorkingDirectory(): Promise<string | null> {
  const plist = path.join(
    os.homedir(),
    "Library/LaunchAgents",
    `${LABEL}.plist`,
  );
  try {
    const xml = fs.readFileSync(plist, "utf8");
    const m = xml.match(
      /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/,
    );
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function cmdInstallLaunchd(): Promise<number> {
  const plist = path.join(os.homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
  if (!fs.existsSync(plist)) {
    console.error(`找不到 ${plist}`);
    return 1;
  }
  if (!fs.existsSync(P.current)) {
    console.error(`${P.current} 还不存在 —— 先跑一次 make deploy`);
    return 1;
  }
  const xml = fs.readFileSync(plist, "utf8");
  const m = xml.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/);
  if (!m) {
    console.error("plist 里没有 WorkingDirectory，不敢自动改");
    return 1;
  }
  if (path.resolve(m[1]) === path.resolve(P.current)) {
    console.log(`已经指向 ${P.current}，无需改动`);
    return 0;
  }
  const backup = `${plist}.bak-${Date.now()}`;
  fs.copyFileSync(plist, backup);
  const next = xml.replace(
    /(<key>WorkingDirectory<\/key>\s*<string>)[^<]*(<\/string>)/,
    `$1${P.current}$2`,
  );
  fs.writeFileSync(plist, next);
  console.log(`WorkingDirectory: ${m[1]} → ${P.current}`);
  console.log(`原 plist 备份在 ${backup}`);

  const uid = process.getuid?.();
  await run(["launchctl", "bootout", `gui/${uid}/${LABEL}`], { quiet: true });
  const r = await run(["launchctl", "bootstrap", `gui/${uid}`, plist]);
  if (r.code !== 0) {
    console.error("bootstrap 失败，plist 已改但服务没起来 —— 用备份还原");
    return 1;
  }
  console.log("已重新加载 launchd job");
  return 0;
}

function cmdStatus(): number {
  const st = readDeployState();
  console.log(`根目录      ${P.root}`);
  console.log(`current     ${symlinkTarget(P.current) ?? "(未设置)"}`);
  console.log(`previous    ${symlinkTarget(P.previous) ?? "(无)"}`);
  console.log(
    `部署状态    ${st ? `${st.phase} · ${st.message} · ${st.updatedAt}` : "(无记录)"}`,
  );
  if (st?.logFile) console.log(`日志        ${st.logFile}`);
  return 0;
}

function cmdReleases(): number {
  const cur = symlinkTarget(P.current);
  const prev = symlinkTarget(P.previous);
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(P.releases).sort().reverse();
  } catch {
    console.log("(还没有 release)");
    return 0;
  }
  for (const d of dirs) {
    const full = path.join(P.releases, d);
    const tag = full === cur ? " ← current" : full === prev ? " ← previous" : "";
    console.log(`${d}${tag}`);
  }
  return 0;
}

// ── 入口 ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const force = argv.includes("--force");
const positional = argv.filter((a) => !a.startsWith("--"));
const sub = positional[0];

let code = 0;
switch (sub) {
  case "rollback":
    fs.mkdirSync(P.logs, { recursive: true });
    code = (await rollback()) ? 0 : 1;
    break;
  case "status":
    code = cmdStatus();
    break;
  case "releases":
    code = cmdReleases();
    break;
  case "install-launchd":
    code = await cmdInstallLaunchd();
    break;
  default:
    code = await cmdDeploy(sub || "HEAD", force);
}
process.exit(code);
