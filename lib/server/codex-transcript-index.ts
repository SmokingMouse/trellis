import fs from "node:fs";
import path from "node:path";
import { CODEX_SESSIONS_DIR } from "./codex-paths";

type RolloutIndex = Map<string, string>;

const indexByRoot = new Map<string, RolloutIndex>();
const UUID_IN_NAME =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function dateDirs(parent: string, digits: number): string[] {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && new RegExp(`^\\d{${digits}}$`).test(entry.name),
      )
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

function rolloutFiles(root: string): string[] {
  const files: string[] = [];
  for (const year of dateDirs(root, 4)) {
    const yearDir = path.join(root, year);
    for (const month of dateDirs(yearDir, 2)) {
      const monthDir = path.join(yearDir, month);
      for (const day of dateDirs(monthDir, 2)) {
        const dayDir = path.join(monthDir, day);
        let names: string[];
        try {
          names = fs
            .readdirSync(dayDir)
            .filter((name) => name.startsWith("rollout-") && name.endsWith(".jsonl"))
            .sort((a, b) => b.localeCompare(a));
        } catch {
          continue;
        }
        for (const name of names) files.push(path.join(dayDir, name));
      }
    }
  }
  return files;
}

function sessionIdFromMeta(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const chunks: Buffer[] = [];
    const chunk = Buffer.alloc(64 * 1024);
    let offset = 0;
    // Modern session_meta lines carry base instructions and can be large.
    // Eight MiB is deliberately generous while still bounding corrupt files.
    while (offset < 8 * 1024 * 1024) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (read <= 0) return null;
      const bytes = Buffer.from(chunk.subarray(0, read));
      const newline = bytes.indexOf(10);
      chunks.push(newline >= 0 ? bytes.subarray(0, newline) : bytes);
      offset += read;
      if (newline < 0) continue;
      const entry = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        type?: string;
        payload?: { id?: unknown; session_id?: unknown };
      };
      if (entry.type !== "session_meta") return null;
      const id = entry.payload?.id ?? entry.payload?.session_id;
      return typeof id === "string" && id.trim() ? id : null;
    }
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return null;
}

function buildIndex(root: string): RolloutIndex {
  const index: RolloutIndex = new Map();
  // Files arrive newest-first. Keep the first path if duplicate metadata exists.
  for (const file of rolloutFiles(root)) {
    const ids: string[] = [...(path.basename(file).match(UUID_IN_NAME) ?? [])];
    const metaId = sessionIdFromMeta(file);
    if (metaId) ids.push(metaId);
    for (const id of ids) {
      if (!index.has(id)) index.set(id, file);
    }
  }
  indexByRoot.set(root, index);
  return index;
}

/** Locate a Codex rollout by filename UUID or session_meta id. */
export function findCodexRolloutPath(
  sessionId: string,
  sessionsRoot = CODEX_SESSIONS_DIR,
): string | null {
  const id = sessionId.trim();
  if (!id) return null;
  const root = path.resolve(sessionsRoot);
  let index = indexByRoot.get(root);
  const cached = index?.get(id);
  if (cached && fs.existsSync(cached)) return cached;

  // A missing or stale hit may mean Codex created a rollout after the last scan.
  index = buildIndex(root);
  const found = index.get(id) ?? null;
  return found && fs.existsSync(found) ? found : null;
}

export function rememberCodexRolloutPath(
  sessionId: string,
  rolloutPath: string,
  sessionsRoot = CODEX_SESSIONS_DIR,
): void {
  const root = path.resolve(sessionsRoot);
  const index = indexByRoot.get(root) ?? new Map<string, string>();
  index.set(sessionId, path.resolve(rolloutPath));
  indexByRoot.set(root, index);
}

export function forgetCodexRolloutPath(
  sessionId: string,
  sessionsRoot = CODEX_SESSIONS_DIR,
): void {
  indexByRoot.get(path.resolve(sessionsRoot))?.delete(sessionId);
}

/** Test/process-reset hook; normal callers rely on positive-hit validation. */
export function clearCodexRolloutIndex(): void {
  indexByRoot.clear();
}
