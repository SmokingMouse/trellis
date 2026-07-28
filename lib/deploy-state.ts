import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 部署流水线与网关之间唯一的共享面：一个 JSON 文件 + 一份路径约定。
//
// 为什么要有它：网关（server.ts）在 Next 起不来时得回答「为什么」。这个「为什么」
// 只有部署脚本知道（正在 build？切换后验活失败？已经自动回滚了？），而两者是
// 不同进程、生命周期还相互独立（部署脚本会亲手重启网关）。文件是唯一活得比
// 双方都久的介质。
//
// 刻意不进 sqlite：网关在数据库所在的那份代码本身可能就是坏的时候还得工作，
// 依赖越少越好。

/** 部署产物根。默认 ~/.trellis，测试演练用 TRELLIS_DEPLOY_ROOT 整体挪走。 */
export function deployRoot(): string {
  return process.env.TRELLIS_DEPLOY_ROOT || path.join(os.homedir(), ".trellis");
}

export function deployPaths() {
  const root = deployRoot();
  return {
    root,
    releases: path.join(root, "releases"),
    current: path.join(root, "current"),
    previous: path.join(root, "previous"),
    backups: path.join(root, "backups"),
    logs: path.join(root, "logs"),
    bin: path.join(root, "bin"),
    state: path.join(root, "deploy-state.json"),
  };
}

export type DeployPhase =
  | "idle"
  | "preflight"
  | "stage"
  | "install"
  | "build"
  | "smoke"
  | "backup"
  | "switch"
  | "verify"
  | "rollback"
  | "done"
  | "failed"
  /** 切换失败且回滚也没救回来 —— 维护页要喊得最大声的那一档 */
  | "broken";

export type DeployState = {
  phase: DeployPhase;
  /** 目标 release 的 git sha（短） */
  sha: string | null;
  /** 回滚目标，仅 switch 之后有意义 */
  previousSha: string | null;
  startedAt: string;
  updatedAt: string;
  /** 当前阶段的一句话人话说明 */
  message: string;
  /** 本次部署日志文件的绝对路径 */
  logFile: string | null;
};

/** 已经落定的阶段；其余都算「还在跑」。 */
const SETTLED: DeployPhase[] = ["idle", "done", "failed", "broken"];

/**
 * 这份 deploy-state 还能不能解释「此刻」。
 *
 * 上周那次失败的部署不该给今天一次无关的崩溃贴上「本次更新失败」的标签。
 * 30 分钟远大于实测的部署时长（约 11s），够宽。
 */
export function isDeployStateFresh(
  s: DeployState | null,
  now = Date.now(),
): s is DeployState {
  return s !== null && now - Date.parse(s.updatedAt) < 30 * 60_000;
}

/**
 * 有没有一个部署正在进行。
 *
 * 必须**同时**看阶段和时效：被 kill 掉的部署会把 `phase` 永远停在 `build`，
 * 只看阶段就再也发不起下一次；只看时效则刚跑完的 `done` 会被误判成在跑。
 */
export function isDeployRunning(
  s: DeployState | null,
  now = Date.now(),
): s is DeployState {
  return isDeployStateFresh(s, now) && !SETTLED.includes(s.phase);
}

export function readDeployState(): DeployState | null {
  try {
    const raw = fs.readFileSync(deployPaths().state, "utf8");
    const s = JSON.parse(raw) as DeployState;
    return typeof s?.phase === "string" ? s : null;
  } catch {
    return null;
  }
}

export function writeDeployState(s: DeployState): void {
  const p = deployPaths();
  fs.mkdirSync(p.root, { recursive: true });
  // 先写临时文件再 rename —— 网关随时可能在读，别让它读到半截 JSON。
  const tmp = `${p.state}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, p.state);
}

/** 日志尾。给维护页用，**只在认证后渲染**（含路径与 stderr）。 */
export function tailLog(file: string | null, lines = 25): string | null {
  if (!file) return null;
  try {
    const all = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    return all.slice(-lines).join("\n");
  } catch {
    return null;
  }
}

/** 当前上线的 release 元信息（部署时写在 release 目录里）。 */
export type ReleaseInfo = {
  sha: string;
  ref: string;
  builtAt: string;
};

export function readReleaseInfo(dir: string): ReleaseInfo | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(dir, "RELEASE.json"), "utf8"),
    ) as ReleaseInfo;
  } catch {
    return null;
  }
}
