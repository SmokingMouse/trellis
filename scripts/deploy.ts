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
//   bun scripts/deploy.ts install-service     把常驻服务的工作目录指向 <root>/current
//
// 环境变量：TRELLIS_DEPLOY_ROOT（产物根，演练用）/ TRELLIS_DEPLOY_LABEL /
// TRELLIS_DEPLOY_PORT（网关端口，验活用）/ TRELLIS_DEPLOY_UNIT（systemd unit 名）/
// TRELLIS_DEPLOY_SUPERVISOR（强制 launchd|systemd）。
//
// 两台实例的长驻方式不是一回事（本机 launchd / BOE devbox systemd user unit），
// 差异全收在 lib/deploy-supervisor.ts —— 这个文件里不写 platform 分支。

import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUTH_COOKIE } from "../lib/auth-cookie";
import {
  deployPaths,
  readDeployState,
  writeDeployState,
  type DeployPhase,
  type DeployState,
} from "../lib/deploy-state";
import { resolveSupervisor } from "../lib/deploy-supervisor";

const P = deployPaths();
const SV = resolveSupervisor();
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
  cookie?: string | null,
): Promise<{ status: number; body: string } | null> {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: cookie ? { cookie } : {},
    });
    return { status: r.status, body: await r.text() };
  } catch {
    return null;
  }
}

/**
 * 从 release 自己的 env 文件里取认证 token，拼成 cookie 给 smoke 用。
 *
 * 不这么做的话 smoke 只能验到 `/login`：闸开着时其余路径一律 401，而闸恰恰
 * 是**默认开着**的（凭证经 shared/.env.local 进来，bun 从 cwd 自动加载，删
 * spawn 环境变量拦不住）。值不落日志。
 */
function smokeCookie(dir: string): string | null {
  for (const f of [".env.local", ".env"]) {
    try {
      const m = fs
        .readFileSync(path.join(dir, f), "utf8")
        .match(/^\s*TRELLIS_AUTH_TOKEN\s*=\s*(.+)$/m);
      if (m) return `${AUTH_COOKIE}=${m[1].trim().replace(/^["']|["']$/g, "")}`;
    } catch {
      /* 没这个文件 */
    }
  }
  return null;
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

/**
 * 部署行为由这几个文件决定 —— 也就是「正在跑的这套流程」自己的身份。
 * 它们必须与被部署的那个 sha 对齐，否则「改了部署流程」这件事本身永远不生效。
 */
const MACHINERY = [
  "scripts/deploy.ts",
  "lib/deploy-supervisor.ts",
  "lib/deploy-state.ts",
];

/** 某个 commit 里这个路径的 blob sha；null = 那个版本里没有这个文件。 */
async function blobInCommit(sha: string, p: string): Promise<string | null> {
  const r = await run(["git", "rev-parse", `${sha}:${p}`], { quiet: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** 磁盘上这个文件的 blob sha（= 本次真正在执行的那份代码）。 */
async function blobOnDisk(p: string): Promise<string | null> {
  if (!fs.existsSync(path.join(REPO, p))) return null;
  const r = await run(["git", "hash-object", p], { quiet: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * 「干活的这套部署流程」是不是被部署那个版本里的那一套。
 *
 * 这是 S86 连栽两次的坑：脚本从**工作树**跑，而界面「更新到最新」部署的是
 * `origin/main`（`app/api/update/route.ts:55` 的默认值）。于是 fetch 到了新
 * commit、release 里装的是新代码，干活的却还是工作树里那份旧脚本 —— 修的正是
 * 部署流程本身时，改动静默失效，报错一模一样地再来一遍。
 *
 * 区分两种不一致，只拦真正会骗人的那种：
 *   落后（HEAD 是目标的祖先）→ 拦。新版流程压根没参与，本次部署名不副实。
 *   本地未提交改动 → 只提醒。开发时的常态，且磁盘上这份就是你想跑的那份。
 */
async function checkMachinery(sha: string, force: boolean): Promise<void> {
  const stale: string[] = [];
  const edited: string[] = [];
  for (const p of MACHINERY) {
    const [inTarget, inHead, onDisk] = await Promise.all([
      blobInCommit(sha, p),
      blobInCommit("HEAD", p),
      blobOnDisk(p),
    ]);
    if (onDisk === inTarget) continue;
    (inHead === inTarget ? edited : stale).push(p);
  }

  if (edited.length > 0) {
    log(`   ! 部署流程有未提交改动（${edited.join(" / ")}）—— 本次跑的是磁盘上这份`);
  }
  if (stale.length === 0) return;

  const short = sha.slice(0, 9);
  const files = stale.join(" / ");
  const behind = await run(["git", "merge-base", "--is-ancestor", "HEAD", sha], {
    quiet: true,
  });
  if (behind.code !== 0) {
    // 目标不是工作树的后代（按老 sha 回滚、部署别的分支）—— 不一致是意料之中的。
    log(`   ! ${files} 与 ${short} 里的版本不同 —— 本次仍用工作树这份流程跑`);
    return;
  }
  const msg =
    `工作树的部署流程落后于 ${short}（${files}）—— 本次会用**工作树这份旧流程**` +
    `去部署新代码，流程自身的改动不会生效。先 git pull --ff-only 再重跑`;
  if (!force) throw new Error(`${msg}；确认要用旧流程就加 --force`);
  log(`   ! ${msg}`);
  log("   ! --force：用旧流程继续");
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

  await checkMachinery(sha, force);

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

  // ── 重启通路必须在**碰任何东西之前**验通 ──
  // 整套设计只有一个承诺：「switch 之前失败 = prod 一根汗毛没动」。而重启是 switch
  // 的最后一步，它要是到那时才发现跑不了（S86：Linux 上没有 launchctl），失败就
  // 恰好落在承诺的缝里 —— 软链已经翻过去、服务还是旧的。所以宁可在这里问一次。
  const probe = await SV.probe(run);
  if (!probe.ok) throw new Error(`${SV.name} 用不了：${probe.reason}`);
  log(`   ${SV.name}`);

  const wd = await SV.workingDirectory(run);
  if (!wd) {
    log(`   ! 读不出 ${SV.name} 的工作目录，无法确认本次切换会生效`);
  } else if (path.resolve(wd) !== path.resolve(P.current)) {
    // 拦而不是只警告：这种状态下重启只会让服务在**原目录**里重新起一遍，与部署的
    // 那个 sha 毫无关系 —— 一次「看着成功、其实换了个无关版本」的上线比失败更坏。
    const msg =
      `${SV.name} 的工作目录是 ${wd}，不是 ${P.current} —— 本次切换不会生效` +
      `（重启只是让服务在原目录里重来一遍）。先跑一次 make install-service`;
    if (!force) throw new Error(`${msg}；确认要继续就加 --force`);
    log(`   ! ${msg}`);
    log("   ! --force：照样继续");
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

/**
 * 把运行期配置挂进新 release。
 *
 * `git archive` 只导出**已跟踪**的文件，而 trellis 的认证凭证住在 `.env.local`
 * 里（bun 从 cwd 自动加载），那个文件被 `.gitignore` 忽略。第一次真上线就踩了：
 * release 里没有它 → `TRELLIS_AUTH_PASS` 缺失 → **网关的认证闸静默关掉**，
 * 公网隧道后面的平台直接裸奔。日志里只有一行 `auth OFF` 的差别。
 *
 * 所以这类文件的真源挪到 `~/.trellis/shared/`，每个 release 软链过去 —— 配置
 * 不再跟着某一个 checkout 走，也不会被下一次 `git archive` 甩掉。
 */
function linkShared(dir: string): void {
  const shared = path.join(P.root, "shared");
  let names: string[];
  try {
    names = fs.readdirSync(shared);
  } catch {
    return;
  }
  for (const n of names) {
    const target = path.join(shared, n);
    const link = path.join(dir, n);
    try {
      fs.rmSync(link, { force: true });
    } catch {
      /* 没有就算了 */
    }
    fs.symlinkSync(target, link);
    log(`   ← shared/${n}`);
  }
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
    // ★ S88：smoke 用的是**真数据快照**，里面有真任务表。不关掉调度器，这个
    // 临时实例会看到到期任务并**真 spawn claude 去跑** —— 花真钱、动真 workspace。
    // 「验证新版本能不能跑」绝不该顺带执行一遍用户的自动化任务。
    TRELLIS_SCHEDULER: "off",
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

    const cookie = smokeCookie(dir);
    const authOn = await (async () => {
      const h = await httpGet(`http://127.0.0.1:${gatePort}/__gate/health`, 3000);
      try {
        return h ? JSON.parse(h.body).auth === "on" : false;
      } catch {
        return false;
      }
    })();
    if (authOn && !cookie) {
      throw new Error("smoke 失败：闸是开的但取不到 TRELLIS_AUTH_TOKEN，无法验证闸后的页面");
    }
    log(`   闸 ${authOn ? "on（带 cookie 验闸后页面）" : "off"}`);

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
      const r = await httpGet(`http://127.0.0.1:${gatePort}${p}`, 15_000, cookie);
      if (!r || !ok(r)) {
        throw new Error(`smoke 失败：${p} → ${r ? r.status : "无响应"}`);
      }
      log(`   ✓ ${p}`);
    }

    // 闸开着就得真的拦得住。这条正对着本次踩的坑：服务活得好好的、页面全能开，
    // 只是不再拦人了 —— 上面那些 200 一个都发现不了。
    if (authOn) {
      const naked = await httpGet(`http://127.0.0.1:${gatePort}/api/sessions`, 10_000);
      if (!naked || naked.status !== 401) {
        throw new Error(
          `smoke 失败：闸声称是开的，但无 cookie 的 /api/sessions 返回 ${naked ? naked.status : "无响应"}（应 401）`,
        );
      }
      log("   ✓ 无 cookie 的 /api/sessions → 401（闸真的拦得住）");
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
  await SV.restart(run);
}

/** 网关当前的认证闸状态；老网关没有这个字段时返回 null（不参与断言）。 */
async function gateAuthState(): Promise<"on" | "off" | null> {
  const h = await httpGet(`http://127.0.0.1:${GATE_PORT}/__gate/health`, 3000);
  if (!h || h.status !== 200) return null;
  try {
    const a = JSON.parse(h.body).auth;
    return a === "on" || a === "off" ? a : null;
  } catch {
    return null;
  }
}

async function verify(authBefore?: "on" | "off" | null): Promise<boolean> {
  phase("verify", `轮询 127.0.0.1:${GATE_PORT}`);
  // 实测冷启动（网关 + 预构建的 Next）约 1.1s，60s 足够宽；再放宽只是让坏版本
  // 多躺一会儿 —— 这段时间是真的不可用，回滚要等它走完。
  const deadline = Date.now() + 60_000;
  let sawGate = false;
  while (Date.now() < deadline) {
    const h = await httpGet(`http://127.0.0.1:${GATE_PORT}/__gate/health`, 2000);
    if (h?.status === 200) {
      sawGate = true;
      try {
        if (JSON.parse(h.body).next === "ready") {
          log("   ✓ /__gate/health next=ready");
          // 闸不许从开变关。凭证来自未跟踪文件（见 linkShared），漏带的表现
          // 就是这一下 —— 服务活得好好的，只是不再拦人了。
          const after = await gateAuthState();
          if (authBefore === "on" && after === "off") {
            log("   × 认证闸从 on 变成了 off —— 极可能是运行期配置没被带进 release");
            log(`     检查 ${path.join(P.root, "shared")} 与 ${P.current} 里的软链`);
            return false;
          }
          if (after) log(`   ✓ 认证闸 ${after}`);
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
  // 重启方式先问清楚再翻软链。翻了却重启不了 = 磁盘上是新版本、内存里是旧版本，
  // 比不回滚更糟（S86 就是这么留下一个「current 指向没人跑的 release」的现场）。
  const p = await SV.probe(run);
  if (!p.ok) {
    log(`   × 回滚前置检查不过（${SV.name}）：${p.reason}`);
    return false;
  }
  phase("rollback", `current → ${path.basename(target)}`);
  atomicSymlink(target, P.current);
  await SV.restart(run);
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
[ -L "$ROOT/previous" ] || { echo "没有 previous，无法回滚"; exit 1; }
TARGET=$(readlink "$ROOT/previous")
[ -d "$TARGET" ] || { echo "previous 指向的目录不存在：$TARGET"; exit 1; }
ln -s "$TARGET" "$ROOT/current.tmp.$$"
mv -f "$ROOT/current.tmp.$$" "$ROOT/current"
${SV.restartShell()}
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

    // 切换前记下闸的状态，切换后要比对（见 linkShared）
    const authBefore = await gateAuthState();

    dir = await stage(sha, short);
    linkShared(dir);
    await install(dir);
    await build(dir);
    await smoke(dir);
    backup();
    await switchTo(dir);

    if (!(await verify(authBefore))) {
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

/**
 * 一次性：把常驻服务的工作目录指向 `<root>/current`。
 *
 * 跑完这一下，仓库目录就退化成纯开发用的 checkout —— 在里面 build 不再碰线上。
 * plist 还是 systemd unit、kickstart 还是 daemon-reload，都由 supervisor 决定。
 */
async function cmdInstallService(): Promise<number> {
  const file = await SV.unitFile(run);
  if (!file) {
    console.error(`找不到 ${SV.name} 的服务定义文件`);
    return 1;
  }
  if (!fs.existsSync(P.current)) {
    console.error(`${P.current} 还不存在 —— 先跑一次 make deploy`);
    return 1;
  }
  const before = await SV.workingDirectory(run);
  if (before && path.resolve(before) === path.resolve(P.current)) {
    console.log(`已经指向 ${P.current}，无需改动`);
    return 0;
  }

  let backup: string;
  try {
    backup = SV.setWorkingDirectory(file, P.current);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  console.log(`${file}`);
  console.log(`WorkingDirectory: ${before ?? "(读不出)"} → ${P.current}`);
  console.log(`原文件备份在 ${backup}`);

  if (await SV.reload(run)) {
    console.log(`已重新加载 ${SV.name}`);
    return 0;
  }
  // 这里失败 = 服务停着。**必须真的还原**，不能只打印一句「用备份还原」就撂挑子
  // （S79 第一次真上线时就是这样，prod 停了一分钟）。
  console.error("重新加载失败 —— 正在用备份还原并重新拉起");
  fs.copyFileSync(backup, file);
  const back = await SV.reload(run);
  console.error(
    back ? "已还原到改动前的状态" : `还原也失败了，服务现在停着 —— 手工检查 ${file}`,
  );
  return 1;
}

async function cmdStatus(): Promise<number> {
  const st = readDeployState();
  console.log(`根目录      ${P.root}`);
  console.log(`current     ${symlinkTarget(P.current) ?? "(未设置)"}`);
  console.log(`previous    ${symlinkTarget(P.previous) ?? "(无)"}`);
  // 长驻方式两台不一样，且「工作目录指没指对」决定部署到底生不生效 —— 一眼能看见
  // 比事后翻日志强。
  const probe = await SV.probe(run);
  const wd = probe.ok ? await SV.workingDirectory(run) : null;
  console.log(`长驻服务    ${SV.name}${probe.ok ? "" : ` × ${probe.reason}`}`);
  if (probe.ok) {
    const ok = wd && path.resolve(wd) === path.resolve(P.current);
    console.log(
      `工作目录    ${wd ?? "(读不出)"}${ok ? "" : `  ← 不是 ${P.current}，部署不会生效`}`,
    );
  }
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
    code = await cmdStatus();
    break;
  case "releases":
    code = cmdReleases();
    break;
  // install-launchd 是旧名字（那时只有 macOS 一台）。留着当别名，肌肉记忆和文档
  // 里都有它。
  case "install-service":
  case "install-launchd":
    code = await cmdInstallService();
    break;
  default:
    code = await cmdDeploy(sub || "HEAD", force);
}
process.exit(code);
