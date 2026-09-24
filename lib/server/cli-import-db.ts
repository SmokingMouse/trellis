// CLI session 镜像的 DB 落地层（Stage A 收尾 + Stage B watcher 复用）。
// 把 cli-import.ts 解析出的节点树 upsert 进 trellis 的 sessions/nodes/search_index。
// 幂等：节点 id = CLI turn 的 uuid（确定性），重复同步走 ON CONFLICT 更新、不产重复行。
// 详见 progress/cli-sync.md。
import "server-only";
import fs from "node:fs";
import path from "node:path";
import { getDB } from "./sqlite";
import {
  classifyParsedTranscript,
  parseCliTranscript,
  parseCliTranscriptAsync,
} from "./cli-transcript";
import { ensureWorkspaceForPath } from "./workspaces";
import type { ParsedCliSession, ParsedTurn } from "./cli-import";

export type ImportResult = {
  sessionId: string;
  status: "imported" | "updated" | "skipped-native" | "unchanged" | "empty";
  turns: number;
};

// trellis 自己 spawn 的 claude/codex session id 全集 —— 用来在「发现」阶段跳过
// trellis 自有 jsonl（防回环）。务必排除 origin='cli-import' 的行，否则镜像 session
// 会把自己的源 id 也算进来。
export function trellisOwnedSessionIds(): Set<string> {
  const db = getDB();
  const rows = db
    .prepare(
      `SELECT n.claude_session_id AS cid, n.codex_session_id AS xid
       FROM nodes n
       JOIN sessions s ON s.id = n.session_id
       WHERE s.origin != 'cli-import'
         AND (n.claude_session_id IS NOT NULL OR n.codex_session_id IS NOT NULL)`,
    )
    .all() as { cid: string | null; xid: string | null }[];
  const set = new Set<string>();
  for (const r of rows) {
    if (r.cid) set.add(r.cid);
    if (r.xid) set.add(r.xid);
  }
  return set;
}

type LineageRow = {
  trellis_session_id: string;
  cli_session_id: string;
  provider_family: "claude" | "codex";
  jsonl_path: string;
  fork_point_uuid: string | null;
  is_root: number;
  synced_uuid: string | null;
};

type ParsedLineage = {
  row: LineageRow;
  parsed: ParsedCliSession;
};

function lineageRows(trellisSessionId: string): LineageRow[] {
  const db = getDB();
  return db
    .prepare(
      `SELECT trellis_session_id, cli_session_id, provider_family, jsonl_path,
              fork_point_uuid, is_root, synced_uuid
       FROM cli_lineages
       WHERE trellis_session_id = ?
       ORDER BY is_root DESC, jsonl_path`,
    )
    .all(trellisSessionId) as LineageRow[];
}

function parseLineages(rows: LineageRow[]): ParsedLineage[] {
  return parseLineagesChecked(rows).parsed;
}

// ── 持久水位（fj-fix-startup：重启后约 2 分钟不可用窗口）────────────────────
//
// 进程内的 (dev,ino,size,mtimeMs) 指纹缓存重启即空，于是每次启动补齐都得把每个
// attached 会话的 jsonl 全部重读、重解析、重发现一遍才知道「没变」—— 1406 个
// codex 文件那一轮就是 2 分钟满 CPU。水位把「上次成功导入时文件长什么样」落进
// cli_lineages，启动时一个 stat 就能判「没变」。
//
// 何时写：**只在导入成功之后**、与 synced_uuid 同一个事务，stat 取自**解析之前**。
// 解析期间文件又被追加 → 记下的是旧 size → 下次失配 → 重导。宁可多导一次，
// 绝不把没导进去的字节记成「已同步」。
// 谁不写：读不到（unreadable）的成员水位清空 —— 它的内容我们一无所知，不能凭
// 水位跳过。
export type LineageWatermark = {
  size: number;
  mtimeMs: number;
  ino: string;
  dirMtimeMs: number | null;
};

function statWatermark(file: string): LineageWatermark | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    let dirMtimeMs: number | null = null;
    try {
      dirMtimeMs = fs.statSync(path.dirname(file)).mtimeMs;
    } catch {
      dirMtimeMs = null;
    }
    return { size: st.size, mtimeMs: st.mtimeMs, ino: String(st.ino), dirMtimeMs };
  } catch {
    return null;
  }
}

type WatermarkRow = {
  cli_session_id: string;
  jsonl_path: string;
  synced_uuid: string | null;
  wm_size: number | null;
  wm_mtime_ms: number | null;
  wm_ino: string | null;
  wm_dir_mtime_ms: number | null;
  wm_cursor: string | null;
};

/**
 * 启动补齐的跳过判据：这条 lineage 自上次成功导入以来**确定没变**。
 * 全部成立才返回 true（任何一条存疑都退回老路径，老路径永远是正确的）：
 *   ① 至少一个成员，且每个成员都有水位；
 *   ② 每个成员 stat 的 size / mtimeMs / ino 与水位逐一相等 —— 追加（size 变）、
 *      截断、原地重写（mtime 变）、原子替换（ino 变）、删除（stat 失败）都失配；
 *   ③ wm_cursor IS synced_uuid —— 水位是和游标一起写的；有人单独作废了游标
 *      （v1 那种「强制全量重导」的迁移），两者就对不上，以游标为准重导；
 *   ④ 成员所在目录的 mtime 没变；变了则只看目录里**水位之后新出现 / 改过**的
 *      非成员 jsonl（新 fork 只可能在这里面）—— 有就不跳（交给 discover 认领），
 *      没有（只是删了别的文件）就跳过并把目录水位推进到本次 stat。
 * 只 stat / readdir，不打开任何 jsonl。
 */
export function lineageWatermarksCurrent(trellisSessionId: string): boolean {
  const db = getDB();
  const rows = db
    .prepare(
      `SELECT cli_session_id, jsonl_path, synced_uuid, wm_size, wm_mtime_ms,
              wm_ino, wm_dir_mtime_ms, wm_cursor
       FROM cli_lineages WHERE trellis_session_id = ?`,
    )
    .all(trellisSessionId) as WatermarkRow[];
  if (rows.length === 0) return false;
  const members = new Set(rows.map((r) => r.jsonl_path));
  const dirBumps: { dir: string; mtimeMs: number }[] = [];
  for (const row of rows) {
    if (
      row.wm_size === null ||
      row.wm_mtime_ms === null ||
      row.wm_ino === null ||
      row.wm_cursor !== row.synced_uuid
    ) {
      return false;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(row.jsonl_path);
    } catch {
      return false;
    }
    if (
      !st.isFile() ||
      st.size !== row.wm_size ||
      st.mtimeMs !== row.wm_mtime_ms ||
      String(st.ino) !== row.wm_ino
    ) {
      return false;
    }
    const dir = path.dirname(row.jsonl_path);
    let dirMtimeMs: number;
    try {
      dirMtimeMs = fs.statSync(dir).mtimeMs;
    } catch {
      return false;
    }
    if (row.wm_dir_mtime_ms !== null && dirMtimeMs === row.wm_dir_mtime_ms) continue;
    if (row.wm_dir_mtime_ms === null) return false;
    if (hasFreshNonMember(dir, members, row.wm_dir_mtime_ms)) return false;
    dirBumps.push({ dir, mtimeMs: dirMtimeMs });
  }
  if (dirBumps.length > 0) {
    const bump = db.prepare(
      `UPDATE cli_lineages SET wm_dir_mtime_ms = ?
       WHERE trellis_session_id = ? AND jsonl_path = ?`,
    );
    for (const row of rows) {
      const hit = dirBumps.find((b) => b.dir === path.dirname(row.jsonl_path));
      if (hit) bump.run(hit.mtimeMs, trellisSessionId, row.jsonl_path);
    }
  }
  return true;
}

function hasFreshNonMember(
  dir: string,
  members: Set<string>,
  sinceMs: number,
): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return true;
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const full = path.join(dir, name);
    if (members.has(full)) continue;
    try {
      if (fs.statSync(full).mtimeMs >= sinceMs) return true;
    } catch {
      // 刚被删 —— 不是新 fork
    }
  }
  return false;
}

function snapshotWatermarks(rows: LineageRow[]): Map<string, LineageWatermark | null> {
  return new Map(rows.map((r) => [r.cli_session_id, statWatermark(r.jsonl_path)]));
}

// 「读不到」和「读到了但没内容」必须分开。前者意味着我们对这条 lineage 的
// turn 集合**一无所知** —— 拿这种残缺集合去做「不在集合里就删」的清理，会把整条
// lineage 的节点全剥掉（CLI transcript 过期 / 用户清理 / fork jsonl 被删都会走
// 到这里，不是理论风险）。所以解析失败必须能被调用方看见。
//
// 判据是 cli-transcript.ts 的三态 classifyParsedTranscript，与 attach 侧同一套：
// **不能只看 existsSync**。文件在、但 EACCES / EIO / EISDIR / 写到一半坏行时，
// 解析同样返回 null 而 existsSync 为 true —— 旧判据把这种残缺当成「读到了，
// 这条 lineage 就是没内容」，于是清理照常开跑，把 fork lineage 已有的节点整片
// 剥掉（fj-review-ab-2c36 F1：chmod 000 实测 forkNodePreserved=false）。
// 反过来也不能把所有 null 都算 unreadable：合法的零轮次会话本来就返回 null，
// 那是确定性的 empty，不该因此永久禁掉清理。
//
// 关于 stat 短路与增量缓存（./cli-transcript）对这条不变量的影响：缓存**只**在
// 文件仍然存在、inode 未变、且长度单调增长时才复用。文件一旦消失，
// parseCliTranscript / parseCliTranscriptAsync 会先作废缓存再返回 null，随后
// classifyParsedTranscript 重新读一次文件定性 —— 缓存不会把「读不到」悄悄变成
// 「读到了但没内容」。
type CheckedLineages = {
  parsed: ParsedLineage[];
  anyUnreadable: boolean;
  /** 读不到的成员（cli_session_id）—— 它们的水位要清空，不能被跳过。 */
  unreadable: Set<string>;
};

function parseLineagesChecked(rows: LineageRow[]): CheckedLineages {
  const out: ParsedLineage[] = [];
  const unreadable = new Set<string>();
  for (const row of rows) {
    const parsed = parseCliTranscript(row.provider_family, row.jsonl_path);
    const state = classifyParsedTranscript(row.jsonl_path, parsed);
    if (state.kind === "unreadable") {
      unreadable.add(row.cli_session_id);
      continue;
    }
    if (state.kind === "empty") continue;
    out.push({ row, parsed: state.parsed });
  }
  return { parsed: out, anyUnreadable: unreadable.size > 0, unreadable };
}

// 同上，但解析分片让出事件循环（watcher / 启动补齐走这条）。判据逐字相同。
async function parseLineagesCheckedAsync(
  rows: LineageRow[],
): Promise<CheckedLineages> {
  const out: ParsedLineage[] = [];
  const unreadable = new Set<string>();
  for (const row of rows) {
    const parsed = await parseCliTranscriptAsync(
      row.provider_family,
      row.jsonl_path,
    );
    const state = classifyParsedTranscript(row.jsonl_path, parsed);
    if (state.kind === "unreadable") {
      unreadable.add(row.cli_session_id);
      continue;
    }
    if (state.kind === "empty") continue;
    out.push({ row, parsed: state.parsed });
  }
  return { parsed: out, anyUnreadable: unreadable.size > 0, unreadable };
}

function unionTurns(parsedRows: ParsedLineage[]): ParsedTurn[] {
  const byId = new Map<string, ParsedTurn>();
  for (const item of parsedRows) {
    for (const t of item.parsed.turns) {
      if (!byId.has(t.id)) byId.set(t.id, { ...t });
    }
  }
  const turns = [...byId.values()];
  const byParent = new Map<string | null, ParsedTurn[]>();
  for (const t of turns) {
    (byParent.get(t.parentId) ?? byParent.set(t.parentId, []).get(t.parentId)!).push(t);
  }
  for (const group of byParent.values()) {
    group.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    group.forEach((t, i) => (t.siblingIndex = i));
  }
  return turns.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

function lineageSidByTurn(parsedRows: ParsedLineage[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of parsedRows) {
    for (const t of item.parsed.turns) {
      if (!out.has(t.id)) out.set(t.id, item.row.cli_session_id);
    }
  }
  return out;
}

function nodesHaveLineageSids(
  db: ReturnType<typeof getDB>,
  trellisSessionId: string,
  expected: Map<string, string>,
  provider: "claude" | "codex",
): boolean {
  const column = provider === "codex" ? "codex_session_id" : "claude_session_id";
  const rows = db
    .prepare(`SELECT id, ${column} AS sid FROM nodes WHERE session_id = ?`)
    .all(trellisSessionId) as { id: string; sid: string | null }[];
  const actual = new Map(rows.map((row) => [row.id, row.sid]));
  for (const [turnId, lineageSid] of expected) {
    if (actual.get(turnId) !== lineageSid) return false;
  }
  return true;
}

function lineageNewestTurn(trellisSessionId: string): ParsedTurn | null {
  const rows = lineageRows(trellisSessionId);
  const parsedRows = parseLineages(rows);
  const turns = unionTurns(parsedRows);
  return turns.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0] ?? null;
}

// 解析前的纯 DB 前置检查。同步/异步两个入口共用，保证两条路的短路判据一致。
function importPrelude(
  trellisSessionId: string,
): { rows: LineageRow[] } | { done: ImportResult } {
  const db = getDB();
  const rows = lineageRows(trellisSessionId);
  if (rows.length === 0) {
    return { done: { sessionId: trellisSessionId, status: "empty", turns: 0 } };
  }

  // 既有 native session 撞 id → 不碰（那是 trellis 自己的，绝不覆盖）。
  const existing = db
    .prepare("SELECT origin FROM sessions WHERE id = ?")
    .get(trellisSessionId) as { origin: string } | undefined;
  if (existing && existing.origin !== "cli-import" && existing.origin !== "herdr") {
    return {
      done: { sessionId: trellisSessionId, status: "skipped-native", turns: 0 },
    };
  }
  return { rows };
}

// 把一个 attached CLI lineage 组 union 镜像/更新进同一个 trellis session。
// 返回状态供调用方决定是否提示。
export function importCliLineage(trellisSessionId: string): ImportResult {
  const pre = importPrelude(trellisSessionId);
  if ("done" in pre) return pre.done;
  // 水位 stat 必须先于解析（见 statWatermark 上方）。
  const marks = snapshotWatermarks(pre.rows);
  const checked = parseLineagesChecked(pre.rows);
  return commitCliLineage(trellisSessionId, pre.rows, checked, marks);
}

/**
 * importCliLineage 的非阻塞版：解析阶段分片让出事件循环，DB 落地阶段与同步版
 * 是同一段代码（SQLite 写本来就是同步的，也不是 CPU 尖峰的来源）。
 * watcher 与启动补齐走这条。
 */
export async function importCliLineageAsync(
  trellisSessionId: string,
): Promise<ImportResult> {
  const pre = importPrelude(trellisSessionId);
  if ("done" in pre) return pre.done;
  const marks = snapshotWatermarks(pre.rows);
  const checked = await parseLineagesCheckedAsync(pre.rows);
  return commitCliLineage(trellisSessionId, pre.rows, checked, marks);
}

// 把本轮解析前的 stat 快照落成水位。cursor 取「本轮提交后该成员的 synced_uuid」：
// 有内容的成员 = 本轮 lastUuid（与 updateCursor 同值），空成员 = 原游标不动。
// 读不到的成员一律清空 —— 调用方必须在事务里（或紧随成功返回）调用。
function writeWatermarks(
  db: ReturnType<typeof getDB>,
  trellisSessionId: string,
  rows: LineageRow[],
  checked: CheckedLineages,
  marks: Map<string, LineageWatermark | null>,
): void {
  const cursorBySid = new Map(
    checked.parsed.map((p) => [p.row.cli_session_id, p.parsed.lastUuid]),
  );
  const set = db.prepare(
    `UPDATE cli_lineages
     SET wm_size = ?, wm_mtime_ms = ?, wm_ino = ?, wm_dir_mtime_ms = ?, wm_cursor = ?
     WHERE trellis_session_id = ? AND cli_session_id = ?`,
  );
  for (const row of rows) {
    const mark = checked.unreadable.has(row.cli_session_id)
      ? null
      : (marks.get(row.cli_session_id) ?? null);
    const cursor = cursorBySid.has(row.cli_session_id)
      ? cursorBySid.get(row.cli_session_id)!
      : row.synced_uuid;
    set.run(
      mark?.size ?? null,
      mark?.mtimeMs ?? null,
      mark?.ino ?? null,
      mark?.dirMtimeMs ?? null,
      mark ? cursor : null,
      trellisSessionId,
      row.cli_session_id,
    );
  }
}

function commitCliLineage(
  trellisSessionId: string,
  rows: LineageRow[],
  checked: CheckedLineages,
  marks: Map<string, LineageWatermark | null>,
): ImportResult {
  const db = getDB();
  const { parsed: parsedRows, anyUnreadable } = checked;
  if (parsedRows.length === 0) {
    // 没有任何可导内容，一个节点都不写；但「空」与「读不到」照样要记水位 ——
    // 空成员下次 stat 一致可以跳过，读不到的清空水位。
    writeWatermarks(db, trellisSessionId, rows, checked, marks);
    return { sessionId: trellisSessionId, status: "empty", turns: 0 };
  }

  const turnLineageSids = lineageSidByTurn(parsedRows);
  const turns = unionTurns(parsedRows);
  const provider = parsedRows[0].row.provider_family;
  // 增量游标全命中 → 整组文件都没新增，跳过整个重写。
  const allUnchanged =
    parsedRows.length === rows.length &&
    parsedRows.every(
      ({ row, parsed }) => row.synced_uuid !== null && row.synced_uuid === parsed.lastUuid,
    ) &&
    nodesHaveLineageSids(db, trellisSessionId, turnLineageSids, provider);
  if (allUnchanged) {
    writeWatermarks(db, trellisSessionId, rows, checked, marks);
    return {
      sessionId: trellisSessionId,
      status: "unchanged",
      turns: turns.length,
    };
  }

  const rootParsed =
    parsedRows.find((p) => p.row.is_root === 1) ??
    parsedRows[0];
  const rootPath = rootParsed.row.jsonl_path;
  const roots = turns
    .filter((t) => t.parentId === null)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const rootNodeId = (roots[0] ?? turns[0]).id;
  // attach 走 project 模式才能 resume 续聊（workspace 无状态、chat 无 cwd）。
  // 无 cwd 的会话退回 chat（只能浏览，续聊无意义）。
  const mode = rootParsed.parsed.cwd ? "project" : "chat";

  const hadNodes = Boolean(
    db.prepare("SELECT 1 FROM nodes WHERE session_id = ? LIMIT 1").get(trellisSessionId),
  );

  // S1 归组。事务外解析（可能 spawn git），失败只落「未归组」不影响导入。
  // 上面的 upsert 用 COALESCE 兜底，避免一次解析失败把已有归属清成 NULL。
  let workspaceId: string | null = null;
  if (rootParsed.parsed.cwd) {
    try {
      workspaceId = ensureWorkspaceForPath(rootParsed.parsed.cwd);
    } catch {
      workspaceId = null;
    }
  }

  const tx = db.transaction(() => {
    // ── session upsert（FK：必须先于 nodes）──────────────────────────────
    db.prepare(
      `INSERT INTO sessions
         (id, title, root_node_id, created_at, updated_at, context_mode,
          workspace_path, workspace_id, model, origin, source_jsonl_path,
          synced_uuid, cli_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'cli-import', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         root_node_id = excluded.root_node_id,
         updated_at = excluded.updated_at,
         workspace_path = excluded.workspace_path,
         workspace_id = COALESCE(excluded.workspace_id, sessions.workspace_id),
         model = COALESCE(sessions.model, excluded.model),
         source_jsonl_path = excluded.source_jsonl_path,
         synced_uuid = excluded.synced_uuid,
         cli_provider = excluded.cli_provider`,
    ).run(
      trellisSessionId,
      rootParsed.parsed.title,
      rootNodeId,
      rootParsed.parsed.createdAt,
      rootParsed.parsed.updatedAt,
      mode,
      rootParsed.parsed.cwd,
      workspaceId,
      provider === "codex" ? "codex" : null,
      rootPath,
      rootParsed.parsed.lastUuid,
      provider,
    );

    // 每个节点记录所属 CLI lineage。共享祖先由 root lineage 首先占有，fork 独有
    // turn 归各自 fork lineage；attached 续聊/分叉据此定位源 jsonl。
    const upsertNode = db.prepare(
      `INSERT INTO nodes
         (id, session_id, parent_id, parent_anchor_text, question, response,
          status, error_message, sibling_index, token_input, token_output,
          token_cache_read, token_cache_creation, token_context, created_at, duration_ms,
          kind, tool_calls_json, claude_session_id, codex_session_id,
          cli_turn_uuid, codex_turn_ordinal, final_start)
       VALUES (?, ?, ?, NULL, ?, ?, 'done', NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'qa', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id = excluded.session_id,
         parent_id = excluded.parent_id,
         question = excluded.question,
         response = excluded.response,
         sibling_index = excluded.sibling_index,
         token_input = excluded.token_input,
         token_output = excluded.token_output,
         token_cache_read = excluded.token_cache_read,
         token_cache_creation = excluded.token_cache_creation,
         token_context = excluded.token_context,
         duration_ms = excluded.duration_ms,
         tool_calls_json = excluded.tool_calls_json,
         claude_session_id = excluded.claude_session_id,
         codex_session_id = excluded.codex_session_id,
         cli_turn_uuid = excluded.cli_turn_uuid,
         codex_turn_ordinal = excluded.codex_turn_ordinal,
         final_start = excluded.final_start`,
    );

    const ftsDel = db.prepare(
      "DELETE FROM search_index WHERE source_id = ? AND source_kind IN ('node_question','node_response')",
    );
    const ftsIns = db.prepare(
      "INSERT INTO search_index (text, source_kind, source_id, session_id) VALUES (?, ?, ?, ?)",
    );

    // 全文索引只重建**文本真的变了**的节点（fj-fix-startup）。search_index 是
    // FTS5，source_id / session_id 都是 UNINDEXED —— `WHERE source_id = ?` 每次
    // 都是**整表扫描**。老写法每个 turn 删一次，一次提交 = turns × 全索引行数：
    // 实测第 k 个 5MB 会话的提交要 k × ~130ms 的同步事务（20 个会话时单次 2.7s
    // 阻塞），正是补齐期间 HTTP 整批超时的那段同步。现在按节点分三类：
    //   · 本会话里 question / response 都没变 → 索引行本来就对，不碰；
    //   · 本会话里文本变了 → 旧行要删：1 个就按 source_id 删，多个就一次按
    //     session_id 扫出 rowid 再按 rowid 删（一次扫描代替 N 次）；
    //   · 此前不存在的节点 → 没有旧行可删，直接插；挂在别的会话下被 upsert
    //     搬过来的（罕见）→ 按 source_id 删。
    // 删节点的路径（repo.deleteSession / 下面的清理）都连带删索引行，所以「节点
    // 不存在但索引行还在」不是会出现的状态。
    const before = new Map(
      (
        db
          .prepare("SELECT id, question, response FROM nodes WHERE session_id = ?")
          .all(trellisSessionId) as { id: string; question: string; response: string }[]
      ).map((r) => [r.id, r]),
    );
    const elsewhere = db.prepare("SELECT 1 FROM nodes WHERE id = ?");
    const reindex = new Set<string>();
    const changed = new Set<string>();
    for (const t of turns) {
      const prev = before.get(t.id);
      if (prev) {
        if (prev.question === t.question && prev.response === t.response) continue;
        changed.add(t.id);
      } else if (elsewhere.get(t.id)) {
        ftsDel.run(t.id);
      }
      reindex.add(t.id);
    }
    if (changed.size === 1) {
      for (const id of changed) ftsDel.run(id);
    } else if (changed.size > 1) {
      const delRow = db.prepare("DELETE FROM search_index WHERE rowid = ?");
      const oldRows = db
        .prepare(
          `SELECT rowid AS r, source_id AS id FROM search_index
           WHERE session_id = ? AND source_kind IN ('node_question','node_response')`,
        )
        .all(trellisSessionId) as { r: number; id: string }[];
      for (const row of oldRows) if (changed.has(row.id)) delRow.run(row.r);
    }

    for (const t of turns) {
      upsertNode.run(
        t.id,
        trellisSessionId,
        t.parentId,
        t.question,
        t.response,
        t.siblingIndex,
        t.tokens.input,
        t.tokens.output,
        t.tokens.cacheRead,
        t.tokens.cacheCreation,
        t.tokens.contextTokens,
        t.createdAt,
        t.durationMs ?? null,
        t.toolCalls.length ? JSON.stringify(t.toolCalls) : null,
        provider === "claude"
          ? (turnLineageSids.get(t.id) ?? trellisSessionId)
          : null,
        provider === "codex"
          ? (turnLineageSids.get(t.id) ?? trellisSessionId)
          : null,
        provider === "claude" ? t.id : null,
        provider === "codex" ? (t.turnOrdinal ?? null) : null,
        t.finalStart || null,
      );
      // 重建该节点的全文索引（旧行已在上面删掉；没变的节点不碰）。
      if (!reindex.has(t.id)) continue;
      if (t.question.trim())
        ftsIns.run(t.question, "node_question", t.id, trellisSessionId);
      if (t.response.trim())
        ftsIns.run(t.response, "node_response", t.id, trellisSessionId);
    }

    // 清理「上一版解析建出、这一版不再认可」的节点（判据变更后残留的假 turn，
    // 它们带着当年被劫走的那份回复，和现在归位到真 turn 的那份重复）。
    // 这是**删用户可见数据**，四道闸缺一不可：
    //   id 出现在 jsonl 的 entry uuid 集合里 —— 「这节点当年就是从这个 jsonl 建出来
    //     的」。import 建的节点 id 恒等于某条 entry 的 uuid；trellis 自己建的节点 id
    //     是本地生成的 v4，绝不在里面。**绝不能用 claude_session_id 代替**：
    //     attached 会话里从非 tip 分叉时，chat/route.ts 的 setNodeResumeId 会给
    //     trellis 的临时节点写上 sid，而 reconcileAttachedTurn 只在 run 正常 done 时
    //     兜底 —— 用 sid 当判据会删掉用户打断的那一轮里他自己敲的问题。
    //     （也比 cli_turn_uuid 强：那列是这次才开始写的，存量节点没有。）
    //   status != 'streaming' —— 不碰正在跑的 run
    //   无子节点 —— 上面 upsert 已把真子 turn 的 parent 提升走；还挂着孩子说明用户
    //     在它上面分叉过，保守放过
    //   !anyUnreadable —— 有 lineage 的 jsonl 读不到时，turnIdSet 是残缺的，
    //     「不在集合里就删」会把那条 lineage 的节点整片剥掉。transcript 过期 / 用户
    //     清理 jsonl / 权限与 IO 失败（EACCES、EIO、EISDIR）/ CLI 正写到一半的坏行
    //     都会走到这儿 —— 后面这几种文件**还在**，光看 existsSync 看不出来，
    //     判据因此是 parseLineagesChecked 里的三态分类。而 v1 迁移作废游标后
    //     每个 attached 会话都要重导
    //     一次 —— 没这道闸，升级后第一次启动就是一次批量销毁。
    if (!anyUnreadable) {
      const turnIdSet = new Set(turns.map((t) => t.id));
      const jsonlUuids = new Set<string>();
      for (const item of parsedRows) {
        for (const u of item.parsed.entryUuids) jsonlUuids.add(u);
      }
      const staleLeaves = db.prepare(
        `SELECT id FROM nodes
         WHERE session_id = ?
           AND status != 'streaming'
           AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = nodes.id)`,
      );
      const delNode = db.prepare("DELETE FROM nodes WHERE id = ?");
      // 从叶子往上逐层剥。假 turn 会串成链（旧解析里 A假 → B假 → 真），一轮只能
      // 删掉当时的叶子 B；A 那时还挂着 B 当孩子，得等下一轮才轮到它。每轮至少删
      // 一个，删不动就退出，不会空转。
      for (;;) {
        const batch = (staleLeaves.all(trellisSessionId) as { id: string }[])
          .filter((r) => jsonlUuids.has(r.id) && !turnIdSet.has(r.id));
        if (batch.length === 0) break;
        for (const r of batch) {
          ftsDel.run(r.id);
          delNode.run(r.id);
        }
      }
    }

    const updateCursor = db.prepare(
      `UPDATE cli_lineages
       SET synced_uuid = ?
       WHERE trellis_session_id = ? AND cli_session_id = ?`,
    );
    for (const item of parsedRows) {
      updateCursor.run(
        item.parsed.lastUuid,
        trellisSessionId,
        item.row.cli_session_id,
      );
    }
    writeWatermarks(db, trellisSessionId, rows, checked, marks);
  });
  tx();

  return {
    sessionId: trellisSessionId,
    status: hadNodes ? "updated" : "imported",
    turns: turns.length,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 身份对账（Stage 2，progress/cli-sync.md）：trellis 在 attach 的会话里续聊完一轮后，
// claude 已把这轮写进 jsonl（canonical uuid），但 trellis 流式时建的是临时 nid 节点。
// 二者同一轮，会双份。对账 = 轮询 import 直到 canonical 节点落库 → 删临时节点。
// 自包含、不依赖 watcher、对竞态幂等（watcher 若也 import 了，canonical 已在，照删临时）。
// 返回 sessionId（供 run-bus 广播客户端重载）；非 attached / 该轮没落 jsonl → 返回 null。
export async function reconcileAttachedTurn(
  provisionalNodeId: string,
): Promise<string | null> {
  const db = getDB();
  const node = db
    .prepare("SELECT session_id FROM nodes WHERE id = ?")
    .get(provisionalNodeId) as { session_id: string } | undefined;
  if (!node) return null;
  const session = db
    .prepare(
      "SELECT origin FROM sessions WHERE id = ?",
    )
    .get(node.session_id) as
    | { origin: string }
    | undefined;
  if (!session || session.origin !== "cli-import") return null;

  // 轮询：每轮先 import（幂等，把 jsonl 里已出现的新轮变成 canonical 节点），再看
  // canonical 节点（≠ 临时 nid）是否已落库。done 后 claude 已写 jsonl，通常 1-2 轮命中。
  for (let i = 0; i < 8; i++) {
    importCliLineage(node.session_id);
    const newest = lineageNewestTurn(node.session_id);
    if (newest && newest.id !== provisionalNodeId) {
      const landed = db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(newest.id);
      if (landed) {
        // canonical 已在 → 删临时节点（它没 children：刚续聊的 leaf；也没设
        // claude_session_id：project 只有根设，故删它不会触发 jsonl 清理）。
        const tx = db.transaction(() => {
          db.prepare("DELETE FROM search_index WHERE source_id = ?").run(
            provisionalNodeId,
          );
          db.prepare("DELETE FROM nodes WHERE id = ?").run(provisionalNodeId);
        });
        tx();
        return node.session_id;
      }
    }
    await sleep(300);
  }
  return null; // 超时仍没落 jsonl（极少）：留临时节点，下次 reload 由 watcher 兜底
}
