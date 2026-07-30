import "server-only";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  deployPaths,
  isDeployRunning,
  readDeployState,
  readReleaseInfo,
  type DeployState,
  type ReleaseInfo,
} from "@/lib/deploy-state";
import { resolveSupervisor } from "@/lib/deploy-supervisor";
import { getDB } from "@/lib/server/sqlite";

// 应用内更新（设置页「检查更新 / 更新到最新」）的服务端。
//
// 它**不重新实现部署**——真正干活的仍然是 scripts/deploy.ts（十阶段 + smoke +
// 验活 + 失败自动回滚，S79）。这里只做三件事：读当前跑的是哪个版本、跟仓库比一比、
// 按下扳机。决策记录见 progress/decisions.md。
//
// 两个必须绕开的机关，都写在下面对应函数的注释里：
//   1. release 里没有 .git（git archive 导出的），部署脚本只能在**开发仓库**里跑；
//   2. 部署到 switch 阶段会重启掉正在跑这段代码的进程，所以子进程必须脱离本进程，
//      否则它会跟着一起死，验活和自动回滚全丢。**「脱离」在两台机器上不是一回事**
//      —— launchd 下换会话就够，systemd 下得换 cgroup（见 spawnDeploy）。

/** 部署脚本要在这个 git 仓库里跑；prod 的 release 目录不是仓库。 */
const REPO_ENV = "TRELLIS_REPO_DIR";

export type RepoProblem =
  | { kind: "unset"; hint: string }
  | { kind: "missing"; dir: string; hint: string }
  | { kind: "not-a-repo"; dir: string; hint: string }
  | { kind: "no-script"; dir: string; hint: string };

export type RepoStatus =
  | { ok: true; dir: string }
  | { ok: false; problem: RepoProblem };

export function resolveRepo(): RepoStatus {
  const raw = process.env[REPO_ENV];
  if (!raw) {
    return {
      ok: false,
      problem: {
        kind: "unset",
        // 讲清楚该往哪儿写：release 每次重建，配置的真源在 shared/（S79 用
        // 认证闸静默关闭那次事故换来的约定）。
        hint: `在 ${path.join(deployPaths().root, "shared", ".env.local")} 里加一行 ${REPO_ENV}=<trellis 仓库的绝对路径>，然后重启服务`,
      },
    };
  }
  const dir = path.resolve(raw);
  if (!fs.existsSync(dir)) {
    return { ok: false, problem: { kind: "missing", dir, hint: `${REPO_ENV} 指向的目录不存在` } };
  }
  if (!fs.existsSync(path.join(dir, ".git"))) {
    return { ok: false, problem: { kind: "not-a-repo", dir, hint: `${dir} 不是 git 仓库` } };
  }
  if (!fs.existsSync(path.join(dir, "scripts", "deploy.ts"))) {
    return {
      ok: false,
      problem: { kind: "no-script", dir, hint: `${dir} 里没有 scripts/deploy.ts` },
    };
  }
  return { ok: true, dir };
}

type Git = { ok: true; out: string } | { ok: false; err: string };

function git(dir: string, args: string[], timeoutMs = 20_000): Git {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: timeoutMs });
  if (r.error) return { ok: false, err: (r.error as NodeJS.ErrnoException).code ?? r.error.message };
  if (r.status !== 0) return { ok: false, err: (r.stderr || r.stdout || "").trim() || `exit ${r.status}` };
  return { ok: true, out: r.stdout.trim() };
}

export type Commit = { sha: string; subject: string };

export type UpdateStatus = {
  /** 当前 current 软链指向的 release */
  current: (ReleaseInfo & { dir: string | null }) | null;
  repo: { dir: string | null; problem: RepoProblem | null };
  /** 仓库里 origin/main 的 tip */
  candidate: Commit | null;
  /** current 落后 candidate 几个 commit；null = 比不出来 */
  behind: number | null;
  /** 落后的那些 commit（最新在前，最多 20 条） */
  commits: Commit[];
  deploy: DeployState | null;
  running: boolean;
  /** 正在生成的会话数 —— 切换会把它们全掐断，界面要先说清楚 */
  activeRuns: number;
  /** 上次 fetch 的错误（网络不通不该让整页 500） */
  fetchError: string | null;
};

function currentReleaseDir(): string | null {
  try {
    return fs.realpathSync(deployPaths().current);
  } catch {
    return null;
  }
}

function activeRuns(): number {
  try {
    const row = getDB()
      .prepare("SELECT COUNT(*) AS n FROM nodes WHERE status = 'streaming'")
      .get() as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function parseCommits(out: string): Commit[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(" ");
      return i < 0 ? { sha: l, subject: "" } : { sha: l.slice(0, i), subject: l.slice(i + 1) };
    });
}

/**
 * 当前版本 vs 仓库最新。
 *
 * `doFetch` 为真时先 `git fetch`（走网络，慢且可能失败）；页面首次加载不 fetch，
 * 只读本地已有的 origin/main —— 打开设置页不该卡在网络上。
 */
export function updateStatus(doFetch = false): UpdateStatus {
  const dir = currentReleaseDir();
  const info = dir ? readReleaseInfo(dir) : null;
  const repo = resolveRepo();
  const deploy = readDeployState();

  const base: UpdateStatus = {
    current: info ? { ...info, dir } : null,
    repo: repo.ok ? { dir: repo.dir, problem: null } : { dir: null, problem: repo.problem },
    candidate: null,
    behind: null,
    commits: [],
    deploy,
    running: isDeployRunning(deploy),
    activeRuns: activeRuns(),
    fetchError: null,
  };
  if (!repo.ok) return base;

  let fetchError: string | null = null;
  if (doFetch) {
    const f = git(repo.dir, ["fetch", "--no-tags", "origin", "main"], 60_000);
    if (!f.ok) fetchError = f.err;
  }

  const tip = git(repo.dir, ["log", "-1", "--pretty=%h %s", "origin/main"]);
  if (!tip.ok) return { ...base, fetchError: fetchError ?? tip.err };
  const candidate = parseCommits(tip.out)[0] ?? null;

  // 用 RELEASE.json 里的短 sha 当基准。它是**当前真正在跑的那份代码**的身份，
  // 比「仓库 HEAD 在哪」可靠 —— 仓库可能早就往前走了好几步。
  let behind: number | null = null;
  let commits: Commit[] = [];
  if (info?.sha) {
    const range = `${info.sha}..origin/main`;
    const list = git(repo.dir, ["log", "--pretty=%h %s", "-20", range]);
    const count = git(repo.dir, ["rev-list", "--count", range]);
    if (list.ok && count.ok) {
      commits = parseCommits(list.out);
      behind = Number(count.out) || 0;
    }
    // 比不出来通常是「release 的 sha 在这个仓库里不存在」（换过仓库/历史被改写），
    // 留 null 让界面显示「无法比较」而不是假装是 0。
  }

  return { ...base, candidate, behind, commits, fetchError };
}

export type TriggerResult =
  | { ok: true; logFile: string; pid: number | null }
  | { ok: false; reason: string };

/**
 * 派生部署脚本，并让它**活过自己触发的那次服务重启**。
 *
 * `detached: true` 不是随手加的选项。部署走到 switch 阶段会重启服务 —— 那杀的正是
 * 跑着这个函数的进程。子进程若还留在本进程名下，就会被一起带走，于是 verify 和
 * 「验活失败自动回滚」这两层安全网全部失效，坏版本原地留在 current 上（S82 实测）。
 *
 * **但「脱离」在两台机器上不是一回事**（S86）：launchd 下 setsid 换个会话就够；
 * systemd 默认 KillMode=control-group 是按 **cgroup** 杀的，换会话不换 cgroup，
 * `systemctl restart` 照样把部署进程带走。所以 Linux 上要先经 systemd-run 起一个
 * transient scope 换掉 cgroup（前缀由 supervisor 给，见 lib/deploy-supervisor.ts）。
 *
 * 同理 stdio 全部重定向到文件：父进程一死，管道那头没人读，写日志会 EPIPE。
 */
function spawnDeploy(args: string[], kind: "trigger" | "rollback"): TriggerResult {
  const repo = resolveRepo();
  if (!repo.ok) return { ok: false, reason: repo.problem.hint };

  const st = readDeployState();
  if (isDeployRunning(st)) {
    return { ok: false, reason: `已经有一个部署在跑（${st.phase}：${st.message}）` };
  }

  // process.execPath 就是当前的 bun 可执行文件 —— 比赌 PATH 里有 bun 可靠
  // （launchd / systemd 给的 PATH 与登录 shell 不是一回事）。
  const argv = [path.join(repo.dir, "scripts", "deploy.ts"), ...args];
  const prefix = resolveSupervisor().detachPrefix();
  if (prefix.length > 0) {
    // 探针**真的起一个空 scope**，而不是问 `--version`：systemd-run 装着但 dbus
    // session / XDG_RUNTIME_DIR 不对时它照样跑不起来，而那种失败会晚到 switch
    // 阶段才发作 —— 正是这里要防的东西。
    const probe = spawnSync(prefix[0], [...prefix.slice(1), "--", "true"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (probe.error || probe.status !== 0) {
      const why = probe.error
        ? ((probe.error as NodeJS.ErrnoException).code ?? probe.error.message)
        : (probe.stderr || "").trim() || `exit ${probe.status}`;
      return {
        ok: false,
        reason:
          `跑不了 ${prefix[0]}（${why}）—— 界面触发的部署会在切换时被服务重启一起杀掉，` +
          `连带丢掉验活和自动回滚。请改用命令行：cd ${repo.dir} && make deploy`,
      };
    }
  }
  const cmd = prefix.length > 0 ? prefix[0] : process.execPath;
  const cmdArgs =
    prefix.length > 0
      ? [...prefix.slice(1), "--", process.execPath, ...argv]
      : argv;

  const P = deployPaths();
  fs.mkdirSync(P.logs, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const logFile = path.join(P.logs, `${kind}-${stamp}.log`);

  let fd: number;
  try {
    fd = fs.openSync(logFile, "a");
  } catch (e) {
    return { ok: false, reason: `打不开日志文件：${e instanceof Error ? e.message : String(e)}` };
  }

  // 这些变量描述的是「当前进程是谁」，不是「要部署什么」。带进去会让 smoke 起的
  // 临时实例继承 prod 的身份，属于自找的串台。
  const env = { ...process.env };
  delete env.PORT;
  delete env.TRELLIS_NEXT_PORT;
  delete env.TRELLIS_TTYD_PORT;

  try {
    const child = spawn(cmd, cmdArgs, {
      cwd: repo.dir,
      detached: true,
      stdio: ["ignore", fd, fd],
      env,
    });
    child.unref();
    return { ok: true, logFile, pid: child.pid ?? null };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* 子进程已经拿到自己的副本了 */
    }
  }
}

/** 按下扳机。 */
export function startUpdate(opts: { ref?: string; force?: boolean }): TriggerResult {
  return spawnDeploy(
    [opts.ref || "HEAD", ...(opts.force ? ["--force"] : [])],
    "trigger",
  );
}

/** 回滚到 previous。同一套脱离逻辑（rollback 同样会重启服务）。 */
export function startRollback(): TriggerResult {
  return spawnDeploy(["rollback"], "rollback");
}
