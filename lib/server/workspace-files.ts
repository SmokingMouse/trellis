import "server-only";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getSessionWorkspacePath, getSessionNodes } from "./repo";

// File preview is read-only and fenced to what THIS session actually touched:
// the workspace cwd plus the directories/files its tool calls wrote or edited.
// That covers files generated outside the cwd (Claude often writes elsewhere)
// and subagent/script-generated siblings (a whole touched dir is opened, not
// just the one recorded file) — while still refusing arbitrary disk reads.

// Extension → Content-Type. Drives both how the browser renders the response
// (HTML in an iframe, images inline) and how the client picks a preview mode.
const EXT_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".jsx": "text/plain; charset=utf-8",
  ".py": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "text/xml; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".toml": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".sql": "text/plain; charset=utf-8",
  ".go": "text/plain; charset=utf-8",
  ".rs": "text/plain; charset=utf-8",
  ".java": "text/plain; charset=utf-8",
  ".rb": "text/plain; charset=utf-8",
};

export function mimeForPath(p: string): string {
  return EXT_MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream";
}

export type ResolvedFile = { path: string; mime: string; size: number };

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// A parent dir too broad to whitelist wholesale — opening it would expose far
// more than the session worked in. $HOME itself, top-level system roots, and any
// depth-≤1 path. For files under these we whitelist only the single file.
function isBroadDir(dir: string): boolean {
  const d = dir.replace(/\/+$/, "");
  const broad = new Set([
    os.homedir(),
    os.tmpdir().replace(/\/+$/, ""),
    "/",
    "/Users",
    "/home",
    "/etc",
    "/var",
    "/usr",
    "/bin",
    "/sbin",
    "/opt",
    "/tmp",
    "/private",
    "/private/tmp",
    "/private/var",
    "/private/etc",
  ]);
  return broad.has(d) || d.split("/").filter(Boolean).length <= 1;
}

type Allow = { dirs: Set<string>; files: Set<string> };

// Build the session's preview whitelist (all realpath'd so symlink/firmlink
// forms unify, missing paths skipped):
//  - workspace cwd → whole dir
//  - each Write/Edit file_path → its parent dir (non-broad) else the file itself
function sessionAllow(sessionId: string): Allow {
  const dirs = new Set<string>();
  const files = new Set<string>();
  const addReal = (p: string, asDir: boolean) => {
    try {
      const real = fs.realpathSync(p);
      (asDir ? dirs : files).add(real);
    } catch {
      /* missing on disk — skip */
    }
  };

  const ws = getSessionWorkspacePath(sessionId);
  if (ws) addReal(ws, true);

  let nodes: ReturnType<typeof getSessionNodes>;
  try {
    nodes = getSessionNodes(sessionId);
  } catch {
    nodes = [];
  }
  for (const n of nodes) {
    for (const tc of n.toolCalls ?? []) {
      if (!WRITE_TOOLS.has(tc.name)) continue;
      const input = tc.input as Record<string, unknown> | null;
      if (!input || typeof input !== "object") continue;
      const fp = input.file_path ?? input.notebook_path;
      if (typeof fp !== "string" || !fp.startsWith("/")) continue;
      const dir = path.dirname(fp);
      if (isBroadDir(dir)) addReal(fp, false);
      else addReal(dir, true);
    }
  }
  return { dirs, files };
}

// Resolve an absolute on-disk path, enforcing that its realpath falls inside the
// session's whitelist. Returns null on any failure (escape, missing, non-file).
export function resolveSessionFile(
  sessionId: string,
  absPath: string,
): ResolvedFile | null {
  if (!absPath.startsWith("/")) return null;
  let target: string;
  try {
    target = fs.realpathSync(absPath);
  } catch {
    return null;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const allow = sessionAllow(sessionId);
  const inDir = [...allow.dirs].some(
    (d) => target === d || target.startsWith(d + path.sep),
  );
  if (!inDir && !allow.files.has(target)) return null;

  return { path: target, mime: mimeForPath(target), size: stat.size };
}
