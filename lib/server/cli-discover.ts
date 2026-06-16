// 浏览本机 Claude Code CLI 会话清单（给 attach picker 用，progress/cli-sync.md）。
// 两级懒加载：listProjects() 列项目目录（只数文件、不解析，快）；listSessionsInDir()
// 进一个目录才逐个解析出会话摘要。排除 trellis 自有 jsonl + 已 attach 的。
import "server-only";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseCliSessionJsonl } from "./cli-import";
import { trellisOwnedSessionIds } from "./cli-import-db";
import { getDB } from "./sqlite";
import type { ParsedCliSession, ParsedTurn } from "./cli-import";

export const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

// 路径安全：只允许 PROJECTS_DIR 下的目录（防越权读任意目录）。
export function isWithinProjects(dir: string): boolean {
  const rel = path.relative(PROJECTS_DIR, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function attachedPaths(): Set<string> {
  const db = getDB();
  const rows = db
    .prepare(
      `SELECT jsonl_path AS p
       FROM cli_lineages
       WHERE jsonl_path IS NOT NULL`,
    )
    .all() as { p: string }[];
  return new Set(rows.map((r) => r.p));
}

export type CliLineageMember = {
  sid: string;
  path: string;
  isRoot: boolean;
  forkPointUuid: string | null;
};

export type DiscoveredLineage = {
  rootSid: string;
  members: CliLineageMember[];
};

type ParsedFile = {
  full: string;
  parsed: ParsedCliSession;
  turnIds: Set<string>;
};

function fileOrder(full: string): number {
  try {
    const st = fs.statSync(full);
    return st.birthtimeMs || st.ctimeMs || st.mtimeMs || 0;
  } catch {
    return 0;
  }
}

function forkPointFor(member: ParsedCliSession, otherTurnIds: Set<string>): string | null {
  const turns = [...member.turns].sort((a, b) => a.createdAt - b.createdAt);
  const firstUnique = turns.find((t) => !otherTurnIds.has(t.id));
  if (firstUnique) return firstUnique.parentId;
  const lastShared = [...turns].reverse().find((t) => otherTurnIds.has(t.id));
  return lastShared?.id ?? null;
}

export function discoverLineage(jsonlPath: string): DiscoveredLineage {
  const selected = path.resolve(jsonlPath);
  const dir = path.dirname(selected);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    files = [path.basename(selected)];
  }

  const parsedFiles: ParsedFile[] = [];
  for (const f of files) {
    const full = path.resolve(dir, f);
    const parsed = parseCliSessionJsonl(full);
    if (!parsed || parsed.turns.length === 0) continue;
    parsedFiles.push({
      full,
      parsed,
      turnIds: new Set(parsed.turns.map((t) => t.id)),
    });
  }

  const selectedFile = parsedFiles.find((p) => p.full === selected);
  if (!selectedFile) {
    throw new Error("selected CLI jsonl has no parseable turns");
  }

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) {
      parent.set(x, x);
      return x;
    }
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  const firstOwnerByTurn = new Map<string, string>();
  for (const file of parsedFiles) {
    find(file.full);
    for (const id of file.turnIds) {
      const first = firstOwnerByTurn.get(id);
      if (first) union(first, file.full);
      else firstOwnerByTurn.set(id, file.full);
    }
  }

  const selectedRoot = find(selectedFile.full);
  const group = parsedFiles.filter((p) => find(p.full) === selectedRoot);
  const allTurns = group.flatMap((p) => p.parsed.turns);
  const rootTurn =
    allTurns
      .filter((t) => t.parentId === null)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0] ??
    allTurns.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];

  const rootCandidates = group
    .filter((p) => p.turnIds.has(rootTurn.id))
    .sort(
      (a, b) =>
        fileOrder(a.full) - fileOrder(b.full) ||
        a.parsed.updatedAt - b.parsed.updatedAt ||
        a.full.localeCompare(b.full),
    );
  const rootFile = rootCandidates[0] ?? selectedFile;

  const groupTurnIds = new Set(group.flatMap((p) => p.parsed.turns.map((t: ParsedTurn) => t.id)));
  const members = group.map((p) => {
    const others = new Set(groupTurnIds);
    for (const id of p.turnIds) {
      if (![...group].some((other) => other.full !== p.full && other.turnIds.has(id))) {
        others.delete(id);
      }
    }
    const isRoot = p.full === rootFile.full;
    return {
      sid: p.parsed.sessionId,
      path: p.full,
      isRoot,
      forkPointUuid: isRoot ? null : forkPointFor(p.parsed, others),
    };
  });

  members.sort((a, b) => Number(b.isRoot) - Number(a.isRoot) || a.path.localeCompare(b.path));
  return { rootSid: rootFile.parsed.sessionId, members };
}

// 读前几行拿 cwd（不全解析大文件）。
function sampleCwd(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    const text = buf.toString("utf8", 0, n);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.cwd) return o.cwd as string;
      } catch {
        /* 行可能被截断，继续 */
      }
    }
  } catch {
    /* ignore */
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return null;
}

export type ProjectSummary = {
  dir: string; // 项目目录绝对路径（encoded）
  cwd: string | null; // 真实 cwd（采样一条 jsonl 得到）
  sessionCount: number; // 可 attach 的会话数（排除自有 + 已 attach）
  latestMtime: number;
};

export function listProjects(): ProjectSummary[] {
  const owned = trellisOwnedSessionIds();
  const attached = attachedPaths();
  let dirs: string[];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return [];
  }
  const out: ProjectSummary[] = [];
  for (const d of dirs) {
    const dp = path.join(PROJECTS_DIR, d);
    let files: string[];
    try {
      if (!fs.statSync(dp).isDirectory()) continue;
      files = fs.readdirSync(dp).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    let count = 0;
    let latest = 0;
    let cwd: string | null = null;
    for (const f of files) {
      const sid = f.replace(/\.jsonl$/, "");
      const full = path.join(dp, f);
      if (owned.has(sid) || attached.has(full)) continue;
      count++;
      try {
        const m = fs.statSync(full).mtimeMs;
        if (m > latest) latest = m;
      } catch {
        /* ignore */
      }
      if (!cwd) cwd = sampleCwd(full);
    }
    if (count > 0) out.push({ dir: dp, cwd, sessionCount: count, latestMtime: latest });
  }
  out.sort((a, b) => b.latestMtime - a.latestMtime);
  return out;
}

export type CliSessionSummary = {
  jsonlPath: string;
  sessionId: string;
  title: string;
  turns: number;
  updatedAt: number;
  attached: boolean;
  cwd?: string | null; // 哪个项目（最近活跃扁平视图里用来标上下文）
};

export function listSessionsInDir(dir: string): CliSessionSummary[] {
  const owned = trellisOwnedSessionIds();
  const attached = attachedPaths();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: CliSessionSummary[] = [];
  for (const f of files) {
    const sid = f.replace(/\.jsonl$/, "");
    if (owned.has(sid)) continue;
    const full = path.join(dir, f);
    const parsed = parseCliSessionJsonl(full);
    if (!parsed || parsed.turns.length === 0) continue;
    out.push({
      jsonlPath: full,
      sessionId: parsed.sessionId,
      title: parsed.title,
      turns: parsed.turns.length,
      updatedAt: parsed.updatedAt,
      attached: attached.has(full),
      cwd: parsed.cwd,
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

// 跨所有项目目录、按文件 mtime（= 最后活动时间）排序，取最近活跃的 top N。
// 全量只 stat（快），仅对入选 top N 做完整解析取标题/轮数 —— 让"平时活跃的会话"直接浮顶。
export function listRecentSessions(limit: number): CliSessionSummary[] {
  const owned = trellisOwnedSessionIds();
  const attached = attachedPaths();
  let dirs: string[];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return [];
  }
  const candidates: { full: string; mtime: number }[] = [];
  for (const d of dirs) {
    const dp = path.join(PROJECTS_DIR, d);
    let files: string[];
    try {
      if (!fs.statSync(dp).isDirectory()) continue;
      files = fs.readdirSync(dp).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const sid = f.replace(/\.jsonl$/, "");
      const full = path.join(dp, f);
      if (owned.has(sid) || attached.has(full)) continue;
      try {
        candidates.push({ full, mtime: fs.statSync(full).mtimeMs });
      } catch {
        /* ignore */
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const out: CliSessionSummary[] = [];
  for (const c of candidates) {
    if (out.length >= limit) break;
    const parsed = parseCliSessionJsonl(c.full);
    if (!parsed || parsed.turns.length === 0) continue;
    out.push({
      jsonlPath: c.full,
      sessionId: parsed.sessionId,
      title: parsed.title,
      turns: parsed.turns.length,
      updatedAt: parsed.updatedAt || c.mtime,
      attached: false,
      cwd: parsed.cwd,
    });
  }
  return out;
}
