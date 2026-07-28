import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// 宿主机外部依赖（ttyd / tmux）的探测层。**不带 server-only** —— 大门
// （server.ts，纯 bun 进程）和 Next 侧的 lib/server/ttyd.ts 都要用。
//
// 这里的核心纪律是「失败必须带证据」。原来探测只回一个 boolean，界面上就
// 只能说一句「未找到 ttyd」——而这句话把三种完全不同的处境糊成了一种：
// 真没装 / 装了但没执行位 / 探测那一下超时或 fork 失败。前两种要人去装，
// 第三种重试一下就好。分不清就只能瞎猜，所以 ProbeResult 逐个候选记原因。

export const TTYD_INSTALL_COMMAND = "brew install ttyd";
export const TTYD_MISSING_MESSAGE = `未找到 ttyd（安装：${TTYD_INSTALL_COMMAND}）`;
export const TTYD_HOST_DEPENDENCY_NOTE =
  `Web 终端依赖宿主机安装 ttyd；macOS 安装：${TTYD_INSTALL_COMMAND}`;

export const TTYD_CANDIDATES = [
  "/opt/homebrew/bin/ttyd",
  "/usr/local/bin/ttyd",
  "/usr/bin/ttyd",
];

const PROBE_TIMEOUT_MS = 4000;

export type ProbeAttempt = { path: string; reason: string };
export type ProbeResult = {
  /** 探到的可执行文件；null = 一个都没跑起来 */
  path: string | null;
  /** 每个候选各自为什么没用上（成功那个不入列） */
  tried: ProbeAttempt[];
};

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 候选绝对路径之外，再把 PATH 扫一遍。
 *
 * 三个写死的候选覆盖 Homebrew(arm/intel) 和系统目录，但 asdf / nix / 自己
 * 编译的 ttyd 不在其中 —— 那种情况下「明明 which ttyd 有」却报未找到，
 * 是最让人上火的一类假阴性。
 */
function fromPath(name: string): string[] {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((d) => path.join(d, name));
}

/**
 * 逐个候选试到能跑为止。
 *
 * 先 statSync 过一道再 spawn：不存在的路径直接记 ENOENT，不用为它付一次
 * 进程创建的代价（加上 PATH 之后候选可能有二三十个）。存在的仍然真 spawn ——
 * 「文件在」不等于「能执行」（S77 就踩过 node-pty 的 spawn-helper 没有执行位）。
 */
export function probeExecutable(
  name: string,
  candidates: string[],
  probeArg: string,
): ProbeResult {
  const tried: ProbeAttempt[] = [];
  const seen = new Set<string>();
  for (const p of [...candidates, ...fromPath(name)]) {
    if (seen.has(p)) continue;
    seen.add(p);

    if (!isFile(p)) {
      tried.push({ path: p, reason: "不存在" });
      continue;
    }
    const r = spawnSync(p, [probeArg], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
    // 只看「跑没跑起来」，不看退出码 —— 探测参数的退出码不是我们关心的事。
    if (!r.error) return { path: p, tried };
    const e = r.error as NodeJS.ErrnoException;
    tried.push({ path: p, reason: e.code ?? e.message ?? "未知错误" });
  }
  return { path: null, tried };
}

/** 把探测过程压成一行给日志/界面看：`/opt/homebrew/bin/ttyd: ENOENT; …` */
export function probeSummary(r: ProbeResult): string {
  if (r.tried.length === 0) return "没有候选路径";
  // 全是「不存在」时说人话，别刷一屏路径。
  const real = r.tried.filter((t) => t.reason !== "不存在");
  if (real.length === 0) return `探过 ${r.tried.length} 个路径，都不存在`;
  return real.map((t) => `${t.path}: ${t.reason}`).join("; ");
}

export function firstWorkingExecutable(paths: string[], probeArg: string): string | null {
  return probeExecutable(path.basename(paths[0] ?? ""), paths, probeArg).path;
}

export function hasTtyd(): boolean {
  return probeExecutable("ttyd", TTYD_CANDIDATES, "--version").path !== null;
}
