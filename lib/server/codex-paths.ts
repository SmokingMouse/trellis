import os from "node:os";
import path from "node:path";

// Codex officially supports relocating all user state through CODEX_HOME.
// Keep discovery, resume lookup, watcher coverage, and cleanup on the same
// resolved root as the CLI/backend; mixing ~/.codex with CODEX_HOME silently
// turns valid session ids into "not found".
export const CODEX_HOME_DIR = path.resolve(
  process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
);
export const CODEX_SESSIONS_DIR = path.join(CODEX_HOME_DIR, "sessions");
