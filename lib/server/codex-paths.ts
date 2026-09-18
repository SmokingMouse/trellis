import os from "node:os";
import path from "node:path";
import { canonicalPath } from "./canonical-path";

// Codex officially supports relocating all user state through CODEX_HOME.
// Keep discovery, resume lookup, watcher coverage, and cleanup on the same
// resolved root as the CLI/backend; mixing ~/.codex with CODEX_HOME silently
// turns valid session ids into "not found".
//
// canonicalPath（不是 path.resolve）：$HOME 本身可能是符号链接（devbox 上
// /home/x → /data00/home/x），path.resolve 留着符号前缀，枚举出来的 rollout 路径
// 就和 herdr 侧 realpath 过的物理路径对不上 —— 根因 C。见 ./canonical-path。
export const CODEX_HOME_DIR = canonicalPath(
  process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
);
export const CODEX_SESSIONS_DIR = path.join(CODEX_HOME_DIR, "sessions");
