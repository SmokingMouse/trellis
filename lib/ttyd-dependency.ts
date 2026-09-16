import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 宿主机外部依赖（ttyd / tmux）的探测层。**不带 server-only** —— 大门
// （server.ts，纯 bun 进程）和 Next 侧的 lib/server/ttyd.ts 都要用。
//
// 这里的核心纪律是「失败必须带证据」。原来探测只回一个 boolean，界面上就
// 只能说一句「未找到 ttyd」——而这句话把三种完全不同的处境糊成了一种：
// 真没装 / 装了但没执行位 / 探测那一下超时或 fork 失败。前两种要人去装，
// 第三种重试一下就好。分不清就只能瞎猜，所以 ProbeResult 逐个候选记原因。
//
// 候选路径顺序：$TRELLIS_TTYD_BIN -> ~/.trellis/bin -> ~/.local/bin -> Homebrew -> 系统路径 -> snap -> PATH。
// 注意：macOS 上 ~/.trellis/bin 与 ~/.local/bin 也会优先于 Homebrew（/opt/homebrew 或 /usr/local）。
// 这允许用户通过放置本地二进制来显式覆盖系统全局版本；未配置这两个目录的 macOS 用户行为完全不变。

export function manualInstallCommand(asset?: string): string {
  const a =
    asset ??
    (process.arch === "arm64"
      ? "ttyd.aarch64"
      : process.arch === "arm"
        ? "ttyd.arm"
        : process.arch === "ia32"
          ? "ttyd.i686"
          : "ttyd.x86_64");
  return `mkdir -p ~/.trellis/bin && curl -fsSL -o ~/.trellis/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/${a} && chmod +x ~/.trellis/bin/ttyd`;
}

/** 服务端运维日志与终端启动报错使用的安装提示（不带「点击下方」等前端 UI 动词） */
export function serverTtydInstallHint(): string {
  if (process.platform === "darwin") {
    return "brew install ttyd";
  }
  if (process.platform === "linux") {
    return `下载静态二进制：${manualInstallCommand()}`;
  }
  return "apt install ttyd";
}

/** 按平台给前端界面的安装提示 */
export function installHint(pkg: string): string {
  if (process.platform === "darwin") {
    return `brew install ${pkg}`;
  }
  if (pkg === "ttyd") {
    return `点击下方『自动安装』或手动执行：${manualInstallCommand()}`;
  }
  return `apt install ${pkg}`;
}

export function ttydMissingMessage(): string {
  return `未找到 ttyd（安装：${installHint("ttyd")}）`;
}

export function ttydHostDependencyNote(): string {
  return `Web 终端依赖宿主机安装 ttyd（${serverTtydInstallHint()}）`;
}

export const TTYD_HOST_DEPENDENCY_NOTE = ttydHostDependencyNote();

/** 获取当前环境下的 ttyd 候选路径列表（按优先级从高到低） */
export function ttydCandidates(): string[] {
  const list: string[] = [];
  if (process.env.TRELLIS_TTYD_BIN) {
    list.push(process.env.TRELLIS_TTYD_BIN);
  }
  const home = process.env.HOME || os.homedir();
  if (home) {
    list.push(path.join(home, ".trellis", "bin", "ttyd"));
    list.push(path.join(home, ".local", "bin", "ttyd"));
  }
  list.push(
    "/opt/homebrew/bin/ttyd",
    "/usr/local/bin/ttyd",
    "/usr/bin/ttyd",
    "/snap/bin/ttyd",
  );
  return list;
}

/** 获取当前环境下的 tmux 候选路径列表（按优先级从高到低） */
export function tmuxCandidates(): string[] {
  const list: string[] = [];
  if (process.env.TRELLIS_TMUX_BIN) {
    list.push(process.env.TRELLIS_TMUX_BIN);
  }
  const home = process.env.HOME || os.homedir();
  if (home) {
    list.push(path.join(home, ".local", "bin", "tmux"));
  }
  list.push(
    "/opt/homebrew/bin/tmux",
    "/usr/local/bin/tmux",
    "/usr/bin/tmux",
  );
  return list;
}

const PROBE_TIMEOUT_MS = 4000;

export type ProbeAttempt = { path: string; reason: string };
export type ProbeResult = {
  /** 探到的可执行文件；null = 一个都没跑起来 */
  path: string | null;
  /** 每个候选各自为什么没用上（成功那个不入列） */
  tried: ProbeAttempt[];
  platform?: string;
  arch?: string;
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
 * 候选覆盖 $TRELLIS_TTYD_BIN、~/.trellis/bin、~/.local/bin、Homebrew(arm/intel)、
 * 系统目录及 snap，但 asdf / nix / 自己编译的 ttyd 不在其中 —— 那种情况下
 * 「明明 which ttyd 有」却报未找到，是最让人上火的一类假阴性。
 */
function fromPath(name: string): string[] {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((d) => path.join(d, name));
}

/**
 * 独立探测单个可执行文件能否正常拉起（不搜索 PATH，不回退其他候选）。
 * 成功返回 null；失败返回 { path, reason }。
 */
export function probeSingleExecutable(
  filePath: string,
  probeArg: string,
): ProbeAttempt | null {
  if (!isFile(filePath)) {
    return { path: filePath, reason: "不存在" };
  }
  try {
    const r = spawnSync(filePath, [probeArg], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
    });
    if (!r.error) {
      return null;
    }
    const e = r.error as NodeJS.ErrnoException;
    return { path: filePath, reason: e.code ?? e.message ?? "未知错误" };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    return {
      path: filePath,
      reason: e.code ?? (err instanceof Error ? err.message : "未知错误"),
    };
  }
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
    try {
      const r = spawnSync(p, [probeArg], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
      // 只看「跑没跑起来」，不看退出码 —— 探测参数的退出码不是我们关心的事。
      if (!r.error) {
        return { path: p, tried, platform: process.platform, arch: process.arch };
      }
      const e = r.error as NodeJS.ErrnoException;
      tried.push({ path: p, reason: e.code ?? e.message ?? "未知错误" });
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      tried.push({ path: p, reason: e.code ?? (err instanceof Error ? err.message : "未知错误") });
    }
  }
  return { path: null, tried, platform: process.platform, arch: process.arch };
}

/** 把探测过程压成一行给日志/界面看：列出所有尝试过的路径及原因。若所有路径都不存在，则折叠输出。 */
export function probeSummary(r: ProbeResult): string {
  if (r.tried.length === 0) return "没有候选路径";
  const nonExistent = r.tried.filter((t) => t.reason === "不存在");
  if (nonExistent.length === r.tried.length) {
    return `探过 ${r.tried.length} 个路径，都不存在`;
  }
  return r.tried.map((t) => `${t.path}: ${t.reason}`).join("; ");
}

export function firstWorkingExecutable(paths: string[], probeArg: string): string | null {
  return probeExecutable(path.basename(paths[0] ?? ""), paths, probeArg).path;
}

export function hasTtyd(): boolean {
  return probeExecutable("ttyd", ttydCandidates(), "--version").path !== null;
}
