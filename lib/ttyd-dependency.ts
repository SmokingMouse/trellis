import { spawnSync } from "node:child_process";

export const TTYD_INSTALL_COMMAND = "brew install ttyd";
export const TTYD_MISSING_MESSAGE = `未找到 ttyd（安装：${TTYD_INSTALL_COMMAND}）`;
export const TTYD_HOST_DEPENDENCY_NOTE =
  `Web 终端依赖宿主机安装 ttyd；macOS 安装：${TTYD_INSTALL_COMMAND}`;

export const TTYD_CANDIDATES = [
  "/opt/homebrew/bin/ttyd",
  "/usr/local/bin/ttyd",
  "/usr/bin/ttyd",
];

export function firstWorkingExecutable(paths: string[], probeArg: string): string | null {
  for (const p of paths) {
    const r = spawnSync(p, [probeArg], { encoding: "utf8", timeout: 4000 });
    if (!r.error) return p;
  }
  return null;
}

export function hasTtyd(): boolean {
  return firstWorkingExecutable(TTYD_CANDIDATES, "--version") !== null;
}
