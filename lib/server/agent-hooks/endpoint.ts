// 端点文件的**读**侧：Trellis 告诉 hook 脚本「我在哪个端口、口令是什么」的
// 唯一渠道，路由这边靠它校验来客。写侧（启动时生成）在 ./install.ts。
//
//   $HOME/.trellis/hooks/endpoint.env    TRELLIS_HOOK_PORT= / TRELLIS_HOOK_TOKEN=
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ENDPOINT_FILE_NAME = "endpoint.env";
export const HOOK_SCRIPT_NAME = "trellis-hook.sh";

/** hooks 目录。TRELLIS_HOOK_DIR 只为单测存在 —— 真实运行永远是 ~/.trellis/hooks。 */
export function hooksDir(): string {
  return (
    process.env.TRELLIS_HOOK_DIR || path.join(os.homedir(), ".trellis", "hooks")
  );
}

export function endpointFilePath(): string {
  return path.join(hooksDir(), ENDPOINT_FILE_NAME);
}

/** 解析 endpoint.env（KEY=VALUE 一行一条，值可带引号）。文件不在 → 空对象。 */
export function readEndpointFile(): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(endpointFilePath(), "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** 路由校验用的口令。没装 hook（文件不在）→ null，此时那个口视作没开。 */
export function readHookToken(): string | null {
  return readEndpointFile().TRELLIS_HOOK_TOKEN || null;
}
