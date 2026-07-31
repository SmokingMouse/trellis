import "server-only";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDB } from "@/lib/server/sqlite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type RecentWorkspace = {
  path: string;
  shortName: string;
  lastUsedAt: number;
  // Where we found it; surfaced for debugging the dedupe.
  source: "trellis" | "claude" | "both";
};

const MAX_RESULTS = 20;
// Read at most this many bytes of a jsonl probing for a `cwd` field.
// The user/assistant turns hit ~1-2KB each so 32KB is plenty without
// loading a 5MB transcript.
const JSONL_PROBE_BYTES = 32 * 1024;

export async function GET() {
  const trellisWorkspaces = readTrellisWorkspaces();
  const claudeWorkspaces = readClaudeWorkspaces();
  const freshWorktrees = readWorktreesWithoutSessions();

  // Merge by canonical path. Trellis updated_at beats claude dir mtime
  // (more meaningful "last used"). Source flag promotes to "both" on
  // overlap.
  const merged = new Map<string, RecentWorkspace>();
  // 先铺零 session 的 worktree，再让真有 session 的两路盖上去 —— 它们的
  // lastUsedAt 更有意义（真用过 vs 刚建出来）。
  for (const w of freshWorktrees) {
    merged.set(w.path, w);
  }
  for (const w of trellisWorkspaces) {
    merged.set(w.path, w);
  }
  for (const w of claudeWorkspaces) {
    const existing = merged.get(w.path);
    if (existing) {
      merged.set(w.path, {
        ...existing,
        source: "both",
        // Keep the larger timestamp.
        lastUsedAt: Math.max(existing.lastUsedAt, w.lastUsedAt),
      });
    } else {
      merged.set(w.path, w);
    }
  }

  const result = Array.from(merged.values())
    .filter((w) => fs.existsSync(w.path))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, MAX_RESULTS);

  return Response.json({ workspaces: result });
}

function readTrellisWorkspaces(): RecentWorkspace[] {
  try {
    const db = getDB();
    type Row = { workspace_path: string; updated_at: number };
    const rows = db
      .prepare(
        `SELECT workspace_path, MAX(updated_at) AS updated_at
         FROM sessions
         WHERE workspace_path IS NOT NULL AND workspace_path != ''
         GROUP BY workspace_path`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      path: r.workspace_path,
      shortName: deriveShortName(r.workspace_path),
      lastUsedAt: r.updated_at,
      source: "trellis",
    }));
  } catch {
    return [];
  }
}

/**
 * 还没开过会话的 worktree。
 *
 * 上面两路数据源都以「已经有 session / 已经跑过 claude CLI」为前提，于是刚
 * `git worktree add` 出来的目录**结构性地**进不了「最近」—— 而那恰恰是此刻
 * 最可能被选的目录。实测后果：用户在侧栏建完 worktree，回到这个 picker 里
 * 找不到它，只能去「浏览」一级级点，或者把路径手打一遍。
 *
 * 口径与侧栏的可见性规则一致（lib/server/workspaces.ts 的 `visible`）：
 * `created_by != 'discovered'` 就是 worktree-scan + trellis 两类，即「所有
 * worktree，无论是 trellis 建的还是用户在 CLI 里建的」。不放开到全部
 * workspaces 行 —— discovered 那类是从历史 session 的 cwd 反推出来的，
 * 存量库里混着 /private/tmp、旧 scratch 之类的噪音，且它们本来就有 session、
 * 走第一路进来了。
 */
function readWorktreesWithoutSessions(): RecentWorkspace[] {
  try {
    const db = getDB();
    type Row = { path: string; last_used_at: number | null };
    const rows = db
      .prepare(
        `SELECT w.path AS path, w.last_used_at AS last_used_at
           FROM workspaces w
          WHERE w.created_by != 'discovered'
            AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.workspace_id = w.id)`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      path: r.path,
      shortName: deriveShortName(r.path),
      lastUsedAt: r.last_used_at ?? 0,
      source: "trellis",
    }));
  } catch {
    return [];
  }
}

function readClaudeWorkspaces(): RecentWorkspace[] {
  const root = path.join(os.homedir(), ".claude", "projects");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: RecentWorkspace[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dirPath = path.join(root, ent.name);
    const cwd = resolveCwdFromClaudeDir(dirPath, ent.name);
    if (!cwd) continue;
    const stat = fs.statSync(dirPath);
    out.push({
      path: cwd,
      shortName: deriveShortName(cwd),
      lastUsedAt: stat.mtimeMs,
      source: "claude",
    });
  }
  return out;
}

// Two strategies for recovering the cwd a claude session was spawned in:
// 1. probe a jsonl in the dir for a `cwd` field — authoritative, since the
//    encoded dir name is lossy (any "-" in a real path collides).
// 2. fall back to naive "-" → "/" replace; usually correct for simple paths.
function resolveCwdFromClaudeDir(dirPath: string, dirName: string): string | null {
  try {
    const files = fs.readdirSync(dirPath);
    const jsonl = files.find((f) => f.endsWith(".jsonl"));
    if (jsonl) {
      const cwd = probeJsonlForCwd(path.join(dirPath, jsonl));
      if (cwd) return cwd;
    }
  } catch {
    // ignore
  }
  // Naive reverse: claude encodes "/" → "-". Lossy but acceptable as a
  // fallback — paths with "-" segments can resolve incorrectly, but the
  // fs.existsSync filter in GET() catches those.
  if (!dirName.startsWith("-")) return null;
  return "/" + dirName.slice(1).replace(/-/g, "/");
}

function probeJsonlForCwd(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(JSONL_PROBE_BYTES);
    const bytes = fs.readSync(fd, buf, 0, JSONL_PROBE_BYTES, 0);
    const text = buf.slice(0, bytes).toString("utf8");
    for (const line of text.split("\n")) {
      if (!line.includes('"cwd"')) continue;
      try {
        const parsed = JSON.parse(line) as { cwd?: unknown };
        if (typeof parsed.cwd === "string" && parsed.cwd.startsWith("/")) {
          return parsed.cwd;
        }
      } catch {
        // partial line at buffer boundary — keep scanning
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 这个目录是不是 git 的 linked worktree。
 *
 * 判据是 `.git` 是**文件**而不是目录 —— 主 checkout 里 `.git` 是目录，
 * linked worktree 里它是一个写着 `gitdir: …` 的文件。比 `git rev-parse` 便宜
 * 得多（这函数在列表里每条都要跑一次），也不用 spawn。
 */
function isLinkedWorktree(p: string): boolean {
  try {
    return fs.statSync(path.join(p, ".git")).isFile();
  } catch {
    return false;
  }
}

// Short label for the picker chip. Order of preference:
//   1. package.json "name"
//   2. Cargo.toml [package] name
//   3. .git remote origin basename
//   4. basename of the path
// Worst case we render the basename which is always reasonable.
function deriveShortName(p: string): string {
  // worktree 例外：它和主 checkout 共用同一份 package.json / Cargo.toml，
  // 走下面的清单会让一个 repo 的 N 个 worktree 在列表里全叫同一个名字
  // （实测：trellis 的三个 worktree 并排显示成「trellis / trellis / trellis」，
  // 只能靠底下那行灰色路径分辨）。而 worktree 的目录名就是分支名 —— 恰恰是
  // 此处唯一有区分度、也是用户脑子里记的那个标识。
  if (isLinkedWorktree(p)) return path.basename(p);
  try {
    const pkg = path.join(p, "package.json");
    if (fs.existsSync(pkg)) {
      const j = JSON.parse(fs.readFileSync(pkg, "utf8")) as { name?: string };
      if (typeof j.name === "string" && j.name.trim()) {
        return j.name.trim();
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const cargo = path.join(p, "Cargo.toml");
    if (fs.existsSync(cargo)) {
      const t = fs.readFileSync(cargo, "utf8");
      const m = t.match(/\[package\][\s\S]*?\nname\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    }
  } catch {
    /* ignore */
  }
  // Always-on fallback. Strip ~/ prefix to keep it compact.
  const home = os.homedir();
  if (p === home) return "~";
  if (p.startsWith(home + "/")) return path.basename(p);
  return path.basename(p);
}
