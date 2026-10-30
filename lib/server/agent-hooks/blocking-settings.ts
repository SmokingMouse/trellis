// 阻塞 hook 的开关：只给 trellis 自己拉起的 claude 加 `--settings <本文件>`。
//
// 为什么用单独的 --settings 文件，不用环境变量（TRELLIS_HOOK_BLOCKING=1）：
//   ① 超时。全局 ~/.claude/settings.json 里观测 hook 的 timeout 是 10s（用户的 dotfiles，
//      我们不改）；环境变量方案只能在那条注册里阻塞，10 秒就被 Claude Code 杀掉。--settings
//      里的注册自带 timeout（官方文档：command hook 可配，默认 600s），这里给到 30 分钟 + 重连余量。
//   ② 不外溢。环境变量会被会话里 Bash 起的子进程继承：trellis 会话里再跑 `claude -p`、
//      fenjue / herdr-leader 之类的自动化坐席都会误开阻塞，没人答就白挂 30 分钟。
//      CLI 参数不继承，用户手开的、自动化坐席的会话行为完全不变。
//   ③ 观测快路径零改动。--settings 的 hooks 与全局 hooks 合并、各跑各的（命令串不同，不去重）：
//      全局那条照旧 1.5s 上报、exit 0；这里这条只挂两个事件，带 `--block` 走阻塞分支。
//
// 文件由 trellis 启动时生成（install.ts），命令里写死本实例的端点文件，
// 所以隔离验证实例（HOME 覆盖）拉起的 claude 只会找它自己。
import fs from "node:fs";
import path from "node:path";
import { HOOK_SCRIPT_NAME, endpointFilePath, hooksDir } from "./endpoint";

export const BLOCKING_SETTINGS_NAME = "blocking-settings.json";
/** 30 分钟等作答 + 2 分钟断线重连 + 余量。hook 自己会先到点退出，这只是兜底上限。 */
export const BLOCKING_HOOK_TIMEOUT_S = 2100;
/** TUI 在 hook 跑着时显示的转圈文案（hook 配置字段 statusMessage）。 */
export const BLOCKING_STATUS_MESSAGE = "等待 Trellis 作答（手机 / 网页上答，或在 Trellis 点「交给终端」）";

export function blockingSettingsPath(): string {
  return path.join(hooksDir(), BLOCKING_SETTINGS_NAME);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function blockingHookCommand(): string {
  const script = path.join(hooksDir(), HOOK_SCRIPT_NAME);
  return `TRELLIS_HOOK_ENDPOINT=${shellQuote(endpointFilePath())} /bin/sh ${shellQuote(script)} --block`;
}

export function blockingSettings(): Record<string, unknown> {
  const hook = {
    type: "command",
    command: blockingHookCommand(),
    timeout: BLOCKING_HOOK_TIMEOUT_S,
    statusMessage: BLOCKING_STATUS_MESSAGE,
  };
  return {
    hooks: {
      PreToolUse: [{ matcher: "AskUserQuestion", hooks: [hook] }],
      PermissionRequest: [{ matcher: "*", hooks: [hook] }],
    },
  };
}

export function writeBlockingSettings(): string {
  const file = blockingSettingsPath();
  fs.writeFileSync(file, `${JSON.stringify(blockingSettings(), null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/**
 * 拼进 claude 启动命令的参数（已做 shell 引号）。文件不在（TRELLIS_HOOKS=off / 安装失败）→ ""：
 * 让 claude 读一个不存在的 --settings 会直接报错退出，宁可不阻塞。
 */
export function claudeBlockingArgs(): string {
  const file = blockingSettingsPath();
  return fs.existsSync(file) ? ` --settings ${shellQuote(file)}` : "";
}
