// Browse local Claude Code and Codex CLI transcripts for the attach picker.
// Discovery stays filesystem-backed: transcripts are the canonical source;
// either CLI's private sqlite index is only a cache and may be absent/stale.
import "server-only";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CODEX_SESSIONS_DIR } from "./codex-paths";
import { canonicalPath } from "./canonical-path";
import { parseCliSessionJsonl } from "./cli-import";
import { parseCodexSessionJsonl } from "./codex-import";
import {
  parseCliTranscript,
  parseCliTranscriptAsync,
  type CliProvider,
} from "./cli-transcript";
import { trellisOwnedSessionIds } from "./cli-import-db";
import { getDB } from "./sqlite";
import { makeSlicer } from "./cooperative";
import {
  discoverLineageWithParser,
  discoverLineageWithParserAsync,
  type DiscoveredLineage,
} from "./cli-lineage";

export type { CliLineageMember, DiscoveredLineage } from "./cli-lineage";
export { parseCliTranscript } from "./cli-transcript";
export type { CliProvider } from "./cli-transcript";

// canonicalPath 同 CODEX_HOME_DIR：$HOME 可能是符号链接，两边必须是同一套判据
// （根因 C，见 ./canonical-path）。
export const PROJECTS_DIR = canonicalPath(
  path.join(os.homedir(), ".claude", "projects"),
);
export { CODEX_SESSIONS_DIR } from "./codex-paths";

// 路径安全：只允许 PROJECTS_DIR 下的目录（防越权读任意目录）。
// 候选先 canonical 再比：闸门两侧都用物理路径，符号前缀的合法路径不会被误拒，
// 指向禁区外的符号链接也不会被放行。
export function isWithinProjects(dir: string): boolean {
  const rel = path.relative(PROJECTS_DIR, canonicalPath(dir));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function isWithinCodexSessions(candidate: string): boolean {
  const rel = path.relative(CODEX_SESSIONS_DIR, canonicalPath(candidate));
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

// ── codex 兄弟枚举：短路 + 进程内缓存（根因 D）────────────────────────────────
//
// 现场事实：devbox 的 codex 目录有 1406 个 jsonl / 3.4GB。老实现每次 attach 都
//   ① 重走整棵树 readdir，
//   ② 对**每一个**文件读首行取 session_meta（base_instructions 让首行能有几百 KB，
//      采样上限 2MB），
//   ③ 对每个 cwd 命中的文件再读 4MB 找 rootTurnId。
// herdr-fleet 每 60s snapshot 会把同一批 transcript 重放一遍，于是这三步每轮重来
// —— 实测小文件 0.3s、197MB 那个 2.4s，×N 个坏会话就是 7–16s 的接口延迟。
//
// 缓存形状照抄 cli-transcript.ts：**先 stat，(dev,ino,size,mtimeMs) 与上次完全一致
// 就直接返回缓存，一个字节都不读**。文件被追加/替换 → 指纹变 → 重新采样（存活
// rollout 的 meta 会正常刷新）。目录枚举则按「缓存里每个目录的 mtime 都没变」
// 短路 —— 新建/删除 jsonl 必然改动所在目录的 mtime，追加写不会（追加不改变文件
// 集合，本来就该复用）。
//
// 只在进程内存里，不落盘：这本来就是 watcher 进程的运行期状态，重启后重新评估
// 正是我们要的。

export type CliDiscoverCacheStats = {
  /** 真读了文件首行取 meta 的次数。 */
  metaSamples: number;
  /** 指纹命中、零读取的次数。 */
  metaHits: number;
  /** 指纹 stat 的次数（短路的代价本体）。 */
  fingerprintStats: number;
  /** 真读了文件前缀找 turn id 的次数。 */
  prefixScans: number;
  prefixHits: number;
  /** 真的重走了整棵 codex sessions 树的次数。 */
  treeWalks: number;
  /** 目录 mtime 全对 → 复用上次枚举结果的次数。 */
  treeReuses: number;
};

const discoverStats: CliDiscoverCacheStats = {
  metaSamples: 0,
  metaHits: 0,
  fingerprintStats: 0,
  prefixScans: 0,
  prefixHits: 0,
  treeWalks: 0,
  treeReuses: 0,
};

export function cliDiscoverCacheStats(): CliDiscoverCacheStats {
  return { ...discoverStats };
}

/** 测试用：清空枚举缓存与计数。生产代码不该调用。 */
export function resetCliDiscoverCache(): void {
  metaCache.clear();
  prefixCache.clear();
  codexTree = null;
  for (const key of Object.keys(discoverStats)) {
    discoverStats[key as keyof CliDiscoverCacheStats] = 0;
  }
}

// 上限：条目都很小（一个 CodexMeta / 一个 boolean），按条数封顶就够，不必按字节。
const MAX_FILE_CACHE_ENTRIES = 8192;

function fingerprintOf(file: string): string | null {
  discoverStats.fingerprintStats++;
  try {
    const st = fs.statSync(file);
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return null; // 文件没了 → 不缓存，让调用方自己得到 null
  }
}

function remember<T>(store: Map<string, T>, key: string, value: T): void {
  store.delete(key);
  store.set(key, value);
  while (store.size > MAX_FILE_CACHE_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

const metaCache = new Map<string, { fp: string; meta: CodexMeta | null }>();
const prefixCache = new Map<string, { fp: string; hit: boolean }>();
let codexTree: { dirs: { path: string; mtimeMs: number }[]; files: string[] } | null =
  null;

export function discoverLineage(
  jsonlPath: string,
  provider: CliProvider = "claude",
): DiscoveredLineage {
  // canonical，不是 path.resolve：调用方给的可能是 realpath 过的物理路径
  // （herdr-fleet），而 codexFiles() 枚举出来的是 $HOME 符号前缀的路径。
  // 两边不统一就会在 cli-lineage 的 full === selected 处对不上 —— 根因 C。
  const selected = canonicalPath(jsonlPath);
  if (provider === "codex") {
    // 解析统一走 cli-transcript 这个唯一入口（stat 短路 + 尾部增量 + LRU），
    // 不再各自 parseCodexSessionJsonl 整文件 readFileSync —— 那是首次 attach
    // 在 1.28GB rollout 上一次阻塞数十秒的直接原因（根因 D），而且和它前一步的
    // classify 读的是同一个文件、白读两遍。
    const rootTurnId = parseCliTranscript("codex", selected)?.turns[0]?.id;
    return discoverLineageWithParser(
      selected,
      (file) => parseCliTranscript("codex", file),
      () => codexSiblings(selected, rootTurnId),
    );
  }
  // claude 侧同样收口：~/.claude/projects 走的是同一个可能带符号链接的 $HOME。
  return discoverLineageWithParser(selected, (file) =>
    parseCliTranscript(provider, file),
  );
}

/**
 * discoverLineage 的非阻塞版（herdr 首次 attach / 启动补齐走这条）：解析走
 * parseCliTranscriptAsync 的分片让出路径，兄弟枚举与 meta 采样按时间片让出。
 * 结果与同步版等价。
 */
export async function discoverLineageAsync(
  jsonlPath: string,
  provider: CliProvider = "claude",
): Promise<DiscoveredLineage> {
  const selected = canonicalPath(jsonlPath);
  if (provider === "codex") {
    const rootTurnId = (await parseCliTranscriptAsync("codex", selected))?.turns[0]
      ?.id;
    return discoverLineageWithParserAsync(
      selected,
      (file) => parseCliTranscriptAsync("codex", file),
      () => codexSiblingsAsync(selected, rootTurnId),
    );
  }
  return discoverLineageWithParserAsync(selected, (file) =>
    parseCliTranscriptAsync(provider, file),
  );
}

/** 一个候选文件够不够格算兄弟：同 cwd，且前缀里出现过选中文件的根 turn id。 */
function codexSiblingsAccept(
  file: string,
  selectedCwd: string | null,
  rootTurnId: string | undefined,
): boolean {
  return (
    (sampleCodexMeta(file)?.cwd ?? null) === selectedCwd &&
    (!rootTurnId || filePrefixContains(file, rootTurnId))
  );
}

// out 以 selected 开头、且循环里跳过它：**选中文件必须无条件在候选里**。
// 让它走一遍过滤器（老实现的形状）等于把「枚举缓存里还没有这个刚建出来的文件」
// 或「meta 采样一时读不到」变成 cli-lineage 的 NoTurns —— 那是根因 C 的形状，
// herdr-fleet 会按确定性失败把它永久跳过。
function codexSiblings(
  selected: string,
  rootTurnId: string | undefined,
): string[] {
  const selectedCwd = sampleCodexMeta(selected)?.cwd ?? null;
  const out = [selected];
  for (const file of codexFiles()) {
    if (file === selected) continue;
    if (codexSiblingsAccept(file, selectedCwd, rootTurnId)) out.push(file);
  }
  return out;
}

async function codexSiblingsAsync(
  selected: string,
  rootTurnId: string | undefined,
): Promise<string[]> {
  const selectedCwd = sampleCodexMeta(selected)?.cwd ?? null;
  const out = [selected];
  // 采样与 prefix 扫描都是同步 fs（首次 attach 时 1406 个文件里有多少没缓存就要
  // 读多少），所以每个文件后过一次时间片闸。缓存暖起来之后这里只剩 stat。
  const yieldSlice = makeSlicer();
  for (const file of codexFiles()) {
    if (file === selected) continue;
    const accepted = codexSiblingsAccept(file, selectedCwd, rootTurnId);
    await yieldSlice();
    if (accepted) out.push(file);
  }
  return out;
}

function filePrefixContains(file: string, needle: string): boolean {
  const key = `${file}|${needle}`;
  const fp = fingerprintOf(file);
  const cached = prefixCache.get(key);
  if (cached && fp !== null && cached.fp === fp) {
    discoverStats.prefixHits++;
    remember(prefixCache, key, cached);
    return cached.hit;
  }
  discoverStats.prefixScans++;
  const hit = readPrefixContains(file, needle);
  if (fp !== null) remember(prefixCache, key, { fp, hit });
  return hit;
}

function readPrefixContains(file: string, needle: string): boolean {
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

/**
 * 整棵 codex sessions 树里的 jsonl。**返回的数组是缓存本体，调用方只读、勿改。**
 *
 * 短路判据：上次走树时记下的每一个目录的 mtime 都没变 → 文件集合不可能变。
 * 新建 / 删除 / 改名一个 jsonl 必然改动所在目录的 mtime；新建日期目录改动父目录
 * 的 mtime，所以整棵树的增删都盖得住。**追加写不改目录 mtime** —— 那也正确：
 * 文件集合没变，该复用的就是这份列表（内容新鲜度由每个文件自己的指纹管）。
 */
function codexFiles(): string[] {
  const cached = codexTree;
  if (
    cached &&
    cached.dirs.length > 0 &&
    cached.dirs.every((d) => dirMtimeMs(d.path) === d.mtimeMs)
  ) {
    discoverStats.treeReuses++;
    return cached.files;
  }
  discoverStats.treeWalks++;
  const out: string[] = [];
  const dirs: { path: string; mtimeMs: number }[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    const mtimeMs = dirMtimeMs(dir);
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // mtime 先取后读：先读后取会把「读期间新落的文件」记成已覆盖。
    if (mtimeMs !== null) dirs.push({ path: dir, mtimeMs });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // 根已经是 canonical，但中途任意一层仍可能是符号链接（日期目录被挪到别的
      // 盘就会这样），所以每个文件再收口一次 —— 枚举结果必须与 selected 同形。
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(canonicalPath(full));
      }
    }
  };
  walk(CODEX_SESSIONS_DIR);
  // dirs 为空 = 连根目录都没读到。不缓存，否则 codex 目录晚一点才出现时会被
  // 「空树」永久钉住。
  codexTree = dirs.length > 0 ? { dirs, files: out } : null;
  return out;
}

function dirMtimeMs(dir: string): number | null {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return null;
  }
}

// session_meta is the first complete line in a rollout. Read only a small
// prefix for project grouping and owned-session filtering; full parsing is
// deferred until a project is expanded or a candidate reaches the recent list.
//
// 外层是指纹短路（根因 D）：同一个文件在指纹不变的前提下只读一次首行，之后每次
// 只付一个 stat。1406 个文件的兄弟枚举因此从「每轮重读 1406 次首行」变成
// 「每轮 1406 个 stat」。
function sampleCodexMeta(file: string): CodexMeta | null {
  const fp = fingerprintOf(file);
  const cached = metaCache.get(file);
  if (cached && fp !== null && cached.fp === fp) {
    discoverStats.metaHits++;
    remember(metaCache, file, cached);
    return cached.meta;
  }
  discoverStats.metaSamples++;
  const meta = readCodexMeta(file);
  if (fp !== null) remember(metaCache, file, { fp, meta });
  return meta;
}

function readCodexMeta(file: string): CodexMeta | null {
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
