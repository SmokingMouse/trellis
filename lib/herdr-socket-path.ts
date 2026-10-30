import os from "node:os";
import path from "node:path";

// herdr Unix socket 的定位。单独成文件、不带 server-only：Next 侧的 herdr-client 和
// 大门（server.ts → lib/herdr-stream.ts，纯 bun 进程）都要用，两边必须是同一套判据。
export function resolveHerdrSocketPath(
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.HERDR_SOCKET_PATH) return path.resolve(env.HERDR_SOCKET_PATH);
  if (env.XDG_CONFIG_HOME) {
    return path.join(path.resolve(env.XDG_CONFIG_HOME), "herdr", "herdr.sock");
  }
  const home = env.HOME || os.homedir();
  return path.join(path.resolve(home), ".config", "herdr", "herdr.sock");
}
