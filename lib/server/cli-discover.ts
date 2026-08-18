// Browse local Claude Code and Codex CLI transcripts for the attach picker.
// Discovery stays filesystem-backed: transcripts are the canonical source;
// either CLI's private sqlite index is only a cache and may be absent/stale.
import "server-only";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CODEX_SESSIONS_DIR } from "./codex-paths";
import { parseCliSessionJsonl, type ParsedCliSession } from "./cli-import";
import { parseCodexSessionJsonl } from "./codex-import";
import { trellisOwnedSessionIds } from "./cli-import-db";
import { getDB } from "./sqlite";
import {
  discoverLineageWithParser,
  type DiscoveredLineage,
} from "./cli-lineage";

export type { CliLineageMember, DiscoveredLineage } from "./cli-lineage";

export const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
export { CODEX_SESSIONS_DIR } from "./codex-paths";
export type CliProvider = "claude" | "codex";

// 路径安全：只允许 PROJECTS_DIR 下的目录（防越权读任意目录）。
export function isWithinProjects(dir: string): boolean {
  const rel = path.relative(PROJECTS_DIR, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function isWithinCodexSessions(candidate: string): boolean {
  const rel = path.relative(CODEX_SESSIONS_DIR, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function isAllowedCliPath(provider: CliProvider, candidate: string): boolean {
  return provider === "codex"
    ? isWithinCodexSessions(candidate)
    : isWithinProjects(candidate);
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

export function parseCliTranscript(
  provider: CliProvider,
  jsonlPath: string,
): ParsedCliSession | null {
  return provider === "codex"
    ? parseCodexSessionJsonl(jsonlPath)
    : parseCliSessionJsonl(jsonlPath);
}

export function discoverLineage(
  jsonlPath: string,
  provider: CliProvider = "claude",
): DiscoveredLineage {
  if (provider === "codex") {
    const selected = path.resolve(jsonlPath);
    const selectedParsed = parseCodexSessionJsonl(selected);
    const rootTurnId = selectedParsed?.turns[0]?.id;
    const selectedCwd = sampleCodexMeta(selected)?.cwd ?? null;
    const parseCache = new Map<string, ParsedCliSession | null>([
      [selected, selectedParsed],
    ]);
    return discoverLineageWithParser(
      selected,
      (file) => {
        const resolved = path.resolve(file);
        if (!parseCache.has(resolved)) {
          parseCache.set(resolved, parseCodexSessionJsonl(resolved));
        }
        return parseCache.get(resolved) ?? null;
      },
      () =>
        codexFiles().filter(
          (file) =>
            (sampleCodexMeta(file)?.cwd ?? null) === selectedCwd &&
            (!rootTurnId || file === selected || filePrefixContains(file, rootTurnId)),
        ),
    );
  }
  return discoverLineageWithParser(
    jsonlPath,
    (file) => parseCliTranscript(provider, file),
  );
}

function filePrefixContains(file: string, needle: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(4 * 1024 * 1024);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).includes(Buffer.from(needle));
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
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
  provider: CliProvider;
  key: string; // Claude = encoded dir; Codex = cwd
  cwd: string | null; // 真实 cwd（采样一条 jsonl 得到）
  sessionCount: number; // 可 attach 的会话数（排除自有 + 已 attach）
  latestMtime: number;
};

function listClaudeProjects(): ProjectSummary[] {
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
    if (count > 0) {
      out.push({
        provider: "claude",
        key: dp,
        cwd,
        sessionCount: count,
        latestMtime: latest,
      });
    }
  }
  out.sort((a, b) => b.latestMtime - a.latestMtime);
  return out;
}

export type CliSessionSummary = {
  provider: CliProvider;
  jsonlPath: string;
  sessionId: string;
  title: string;
  turns: number;
  updatedAt: number;
  attached: boolean;
  cwd?: string | null; // 哪个项目（最近活跃扁平视图里用来标上下文）
};

function listClaudeSessionsInDir(dir: string): CliSessionSummary[] {
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
      provider: "claude",
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
function listRecentClaudeSessions(limit: number): CliSessionSummary[] {
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
      provider: "claude",
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

type CodexMeta = {
  sessionId: string;
  cwd: string | null;
};

function codexFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(CODEX_SESSIONS_DIR);
  return out;
}

// session_meta is the first complete line in a rollout. Read only a small
// prefix for project grouping and owned-session filtering; full parsing is
// deferred until a project is expanded or a candidate reaches the recent list.
function sampleCodexMeta(file: string): CodexMeta | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    // base_instructions lives on session_meta and can make the first line
    // hundreds of KB. Read through the first newline instead of assuming a
    // tiny fixed prefix (that silently hid almost every modern Codex thread).
    const chunks: Buffer[] = [];
    const chunk = Buffer.alloc(64 * 1024);
    let offset = 0;
    let firstLine: string | null = null;
    while (offset < 2 * 1024 * 1024) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (read <= 0) break;
      const copy = Buffer.from(chunk.subarray(0, read));
      const newline = copy.indexOf(10);
      chunks.push(newline >= 0 ? copy.subarray(0, newline) : copy);
      offset += read;
      if (newline >= 0) {
        firstLine = Buffer.concat(chunks).toString("utf8");
        break;
      }
    }
    if (!firstLine) return null;
    const entry = JSON.parse(firstLine) as {
      type?: string;
      payload?: Record<string, unknown>;
    };
    if (entry.type !== "session_meta") return null;
    const payload = entry.payload;
    const sessionId =
      typeof payload?.id === "string"
        ? payload.id
        : typeof payload?.session_id === "string"
          ? payload.session_id
          : null;
    if (!sessionId) return null;
    return {
      sessionId,
      cwd: typeof payload?.cwd === "string" ? payload.cwd : null,
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return null;
}

function codexCandidates(): {
  full: string;
  mtime: number;
  meta: CodexMeta;
}[] {
  const owned = trellisOwnedSessionIds();
  const attached = attachedPaths();
  const out: { full: string; mtime: number; meta: CodexMeta }[] = [];
  for (const full of codexFiles()) {
    if (attached.has(full)) continue;
    const meta = sampleCodexMeta(full);
    if (!meta || owned.has(meta.sessionId)) continue;
    try {
      out.push({ full, mtime: fs.statSync(full).mtimeMs, meta });
    } catch {
      /* disappeared while scanning */
    }
  }
  return out;
}

function listCodexProjects(): ProjectSummary[] {
  const byCwd = new Map<string, ProjectSummary>();
  for (const candidate of codexCandidates()) {
    const key = candidate.meta.cwd ?? "";
    const current = byCwd.get(key);
    if (current) {
      current.sessionCount++;
      current.latestMtime = Math.max(current.latestMtime, candidate.mtime);
    } else {
      byCwd.set(key, {
        provider: "codex",
        key,
        cwd: candidate.meta.cwd,
        sessionCount: 1,
        latestMtime: candidate.mtime,
      });
    }
  }
  return [...byCwd.values()].sort((a, b) => b.latestMtime - a.latestMtime);
}

function codexSummary(
  full: string,
  fallbackMtime: number,
  attached: Set<string>,
): CliSessionSummary | null {
  const parsed = parseCodexSessionJsonl(full);
  if (!parsed || parsed.turns.length === 0) return null;
  return {
    provider: "codex",
    jsonlPath: full,
    sessionId: parsed.sessionId,
    title: parsed.title,
    turns: parsed.turns.length,
    updatedAt: parsed.updatedAt || fallbackMtime,
    attached: attached.has(full),
    cwd: parsed.cwd,
  };
}

function listCodexSessionsInProject(cwd: string): CliSessionSummary[] {
  const attached = attachedPaths();
  const out: CliSessionSummary[] = [];
  for (const candidate of codexCandidates()) {
    if ((candidate.meta.cwd ?? "") !== cwd) continue;
    const summary = codexSummary(candidate.full, candidate.mtime, attached);
    if (summary) out.push(summary);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function listRecentCodexSessions(limit: number): CliSessionSummary[] {
  const attached = attachedPaths();
  const candidates = codexCandidates().sort((a, b) => b.mtime - a.mtime);
  const out: CliSessionSummary[] = [];
  for (const candidate of candidates) {
    if (out.length >= limit) break;
    const summary = codexSummary(candidate.full, candidate.mtime, attached);
    if (summary) out.push(summary);
  }
  return out;
}

export function listProjects(provider: CliProvider = "claude"): ProjectSummary[] {
  return provider === "codex" ? listCodexProjects() : listClaudeProjects();
}

export function listSessionsInProject(
  provider: CliProvider,
  key: string,
): CliSessionSummary[] {
  return provider === "codex"
    ? listCodexSessionsInProject(key)
    : listClaudeSessionsInDir(key);
}

/** Legacy Claude-only export kept for server-side callers outside the picker. */
export function listSessionsInDir(dir: string): CliSessionSummary[] {
  return listClaudeSessionsInDir(dir);
}

export function listRecentSessions(
  limit: number,
  provider: CliProvider = "claude",
): CliSessionSummary[] {
  return provider === "codex"
    ? listRecentCodexSessions(limit)
    : listRecentClaudeSessions(limit);
}
