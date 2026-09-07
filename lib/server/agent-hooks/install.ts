// 端点文件的**写**侧，服务启动时跑一次（instrumentation.ts）。
//
//   $HOME/.trellis/hooks/endpoint.env    端口 + 口令
//   $HOME/.trellis/hooks/trellis-hook.sh 仓库里那份的副本（chmod +x）
//
// 为什么脚本要复制出去、而不是让 settings.json 直接指向仓库路径：settings.json
// 跟着 dotfiles 跨机器走，指向某个 checkout 的绝对路径换台机器就断；
// $HOME/.trellis/hooks/ 在哪台机器上都成立。
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  HOOK_SCRIPT_NAME,
  endpointFilePath,
  hooksDir,
  readEndpointFile,
} from "./endpoint";

/** 当前监听端口。TRELLIS_PORT 由 server.ts 这道大门下发给 Next 子进程。 */
function currentPort(): number {
  return Number(process.env.TRELLIS_PORT) || Number(process.env.PORT) || 3088;
}

export type InstallResult = {
  installed: boolean;
  reason?: string;
  endpoint?: string;
  script?: string;
  port?: number;
};

/**
 * 幂等：token 首次随机生成，之后复用文件里那个 —— 换 token 会让所有已经在跑的
 * claude 里的 hook 集体 401。整个过程失败不许拦启动，最坏结果只是「hook 不上报」。
 */
export function installHookEndpoint(): InstallResult {
  if (process.env.TRELLIS_HOOKS === "off") {
    return { installed: false, reason: "TRELLIS_HOOKS=off" };
  }
  try {
    const dir = hooksDir();
    fs.mkdirSync(dir, { recursive: true });

    const token =
      readEndpointFile().TRELLIS_HOOK_TOKEN || randomBytes(24).toString("hex");
    const port = currentPort();
    const endpoint = endpointFilePath();
    fs.writeFileSync(
      endpoint,
      "# 由 trellis 启动时生成（lib/server/agent-hooks/install.ts），勿手改\n" +
        `TRELLIS_HOOK_PORT=${port}\n` +
        `TRELLIS_HOOK_TOKEN=${token}\n`,
      { mode: 0o600 },
    );
    // writeFileSync 的 mode 只对新建文件生效，覆盖已有文件时沿用旧权限 —— 补一刀。
    fs.chmodSync(endpoint, 0o600);

    const dest = path.join(dir, HOOK_SCRIPT_NAME);
    const src = path.join(process.cwd(), "scripts", "hooks", HOOK_SCRIPT_NAME);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, 0o755);
    }
    return { installed: true, endpoint, script: dest, port };
  } catch (e) {
    return { installed: false, reason: String(e) };
  }
}
