// CLI session 实时同步 watcher（per-session attach 模型，progress/cli-sync.md）。
// 用户 attach 或 Herdr 绑定的 CLI 会话带 source_jsonl_path，均为只读镜像。
// watcher 监听这些 jsonl 所在目录，文件变更 → debounce → 重导入对应 attached 会话。
// 只同步 attached 的文件，目录里其它会话一概不碰（per-session，不是 per-dir 灌）。
// 启动点：instrumentation.ts register()，每进程一次。
import "server-only";
import fs from "node:fs";
import path from "node:path";
import { getDB } from "./sqlite";
import {
  importCliLineage,
  importCliLineageAsync,
  type ImportResult,
} from "./cli-import-db";
import { ensureWorkspaceForPath } from "./workspaces";
import {
  CODEX_SESSIONS_DIR,
  discoverLineage,
  discoverLineageAsync,
  isWithinCodexSessions,
  type DiscoveredLineage,
} from "./cli-discover";
import {
  classifyCliTranscript,
  classifyCliTranscriptAsync,
  parseCliTranscriptAsync,
  type CliProvider,
  type CliTranscriptState,
} from "./cli-transcript";
import { findCodexRolloutPath } from "./codex-transcript-index";
import { deleteSession } from "./repo";
import { canonicalPath } from "./canonical-path";
import {
  publishCliSessionUpdated,
  publishCliSyncFailed,
  type CliSyncFailure,
} from "./cli-sync-events";
import {
  CliTranscriptUnreadableError,
  NativeSessionConflictError,
} from "./cli-attach";
import {
  classifyDbError,
  isDbFailure,
  isTransientKind,
  type SqliteFailureKind,
} from "./db-error";
import { notify } from "./notify";

// 当前 attached 会话的源 jsonl 绝对路径集合（每次实时查 DB，保持权威）。
type AttachedPath = { sid: string; provider: CliProvider };
type MirrorOrigin = "cli-import" | "herdr";

function isMirrorOrigin(origin: string): origin is MirrorOrigin {
  return origin === "cli-import" || origin === "herdr";
}

type AttachedPathRow = {
  sid: string;
  provider: CliProvider;
  cliSid: string;
  isRoot: number;
  p: string;
};

function currentAttachedPath(row: AttachedPathRow): string {
  if (row.provider !== "codex" || fs.existsSync(row.p)) return row.p;
  const found = findCodexRolloutPath(row.cliSid);
  if (!found) return row.p;
  const db = getDB();
  db.prepare(
    `UPDATE cli_lineages SET jsonl_path = ?
     WHERE trellis_session_id = ? AND cli_session_id = ?`,
  ).run(found, row.sid, row.cliSid);
  if (row.isRoot === 1) {
    db.prepare("UPDATE sessions SET source_jsonl_path = ? WHERE id = ?").run(
      found,
      row.sid,
    );
  }
  return found;
}

function attachedPathMap(): Map<string, AttachedPath> {
  const db = getDB();
  const rows = db
    .prepare(
      `SELECT trellis_session_id AS sid, provider_family AS provider,
              cli_session_id AS cliSid, is_root AS isRoot, jsonl_path AS p
       FROM cli_lineages
       WHERE jsonl_path IS NOT NULL`,
    )
    .all() as AttachedPathRow[];
  return new Map(
    rows.map((row) => [
      currentAttachedPath(row),
      { sid: row.sid, provider: row.provider },
    ]),
  );
}

function attachedSessions(): {
  id: string;
  provider: CliProvider;
  cwd: string | null;
}[] {
  const db = getDB();
  const rows = db
    .prepare(
      `SELECT id, COALESCE(cli_provider, 'claude') AS provider,
              workspace_path AS cwd
       FROM sessions WHERE origin IN ('cli-import', 'herdr')`,
    )
    .all() as { id: string; provider: CliProvider; cwd: string | null }[];
  return rows;
}

// 一个根 transcript 的三种状态。「读不到」和「读到了但没内容」必须分开 ——
// 同一条不变量在 cli-import-db.ts:parseLineagesChecked 有完整说明（拿残缺集合做
// 「不在集合里就删」的清理会把整条 lineage 的节点剥掉），这里是它在 attach 侧的
// 对应面。
//
// 判据本体住在 ./cli-transcript（classifyParsedTranscript / classifyCliTranscript）：
// attach 侧（这里）和清理侧（cli-import-db）必须是**同一套**判据，各留一份迟早
// 会漂。这里只保留 attach 侧的名字与类型别名，行为完全委托过去。
export type RootTranscriptState = CliTranscriptState;

export function classifyRootTranscript(
  provider: CliProvider,
  file: string,
): RootTranscriptState {
  return classifyCliTranscript(provider, file);
}

function rootMember(discovered: DiscoveredLineage) {
  return discovered.members.find((m) => m.isRoot) ?? discovered.members[0];
}

function seedLineage(
  discovered: DiscoveredLineage,
  provider: CliProvider,
  trellisSessionId = discovered.rootSid,
  origin: MirrorOrigin = "cli-import",
): void {
  const root = rootMember(discovered);
  seedLineageFrom(
    discovered,
    provider,
    classifyRootTranscript(provider, root.path),
    trellisSessionId,
    origin,
  );
}

/**
 * seedLineage 的非阻塞版：唯一的差别是根 transcript 的定性走分片解析
 * （classifyCliTranscriptAsync）。DB 落地那段与同步版**是同一段代码**
 * （seedLineageFrom）—— 两份各写一遍迟早会漂，而这里的失败语义
 * （unreadable→可重试、native 撞 id→确定性）是 herdr-fleet 重试闸的输入。
 */
async function seedLineageAsync(
  discovered: DiscoveredLineage,
  provider: CliProvider,
  trellisSessionId = discovered.rootSid,
  origin: MirrorOrigin = "cli-import",
): Promise<void> {
  const root = rootMember(discovered);
  seedLineageFrom(
    discovered,
    provider,
    await classifyCliTranscriptAsync(provider, root.path),
    trellisSessionId,
    origin,
  );
}

function seedLineageFrom(
  discovered: DiscoveredLineage,
  provider: CliProvider,
  state: RootTranscriptState,
  trellisSessionId: string,
  origin: MirrorOrigin,
): void {
  const db = getDB();
  const root = rootMember(discovered);
  // 0 turn 不是错误：安静跳过（不建 session 行、不动既有节点）。读不到才是错误 ——
  // 调用方必须看得见，否则镜像会话会停在旧快照上而没人知道。
  if (state.kind === "unreadable") {
    throw new CliTranscriptUnreadableError(root.path);
  }
  if (state.kind === "empty") return;
  const parsed = state.parsed;
  const existing = db
    .prepare("SELECT origin FROM sessions WHERE id = ?")
    .get(trellisSessionId) as { origin: string } | undefined;
  if (existing && !isMirrorOrigin(existing.origin)) {
    throw new NativeSessionConflictError(trellisSessionId);
  }

  const roots = parsed.turns
    .filter((t) => t.parentId === null)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const rootNodeId = (roots[0] ?? parsed.turns[0]).id;
  const mode = parsed.cwd ? "project" : "chat";
  // S1 归组。这是**高频**路径（jsonl 每次变动都到这儿），但对已登记目录
  // ensureWorkspaceForPath 走纯 SELECT 快路径、不 spawn git，代价可忽略。
  let workspaceId: string | null = null;
  if (parsed.cwd) {
    try {
      workspaceId = ensureWorkspaceForPath(parsed.cwd);
    } catch {
      workspaceId = null;
    }
  }

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO sessions
         (id, title, root_node_id, created_at, updated_at, context_mode,
          workspace_path, workspace_id, model, origin, source_jsonl_path,
          synced_uuid, cli_provider, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         origin = CASE WHEN excluded.origin = 'herdr' THEN 'herdr' ELSE sessions.origin END,
         kind = CASE WHEN excluded.origin = 'herdr' OR sessions.origin = 'herdr' THEN 'herdr' ELSE sessions.kind END,
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
      parsed.title,
      rootNodeId,
      parsed.createdAt,
      parsed.updatedAt,
      mode,
      parsed.cwd,
      workspaceId,
      provider === "codex" ? "codex" : null,
      origin,
      root.path,
      parsed.lastUuid,
      provider,
      origin === "herdr" ? "herdr" : "user",
    );

    db.prepare("UPDATE cli_lineages SET is_root = 0 WHERE trellis_session_id = ?").run(
      trellisSessionId,
    );
    const upsertLineage = db.prepare(
      `INSERT INTO cli_lineages
         (trellis_session_id, cli_session_id, provider_family, jsonl_path,
          fork_point_uuid, is_root, synced_uuid)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(trellis_session_id, cli_session_id) DO UPDATE SET
         provider_family = excluded.provider_family,
         jsonl_path = excluded.jsonl_path,
         fork_point_uuid = excluded.fork_point_uuid,
         is_root = excluded.is_root`,
    );
    for (const m of discovered.members) {
      upsertLineage.run(
        trellisSessionId,
        m.sid,
        provider,
        m.path,
        m.forkPointUuid,
        m.isRoot ? 1 : 0,
      );
    }
  });
  tx();
}

const watchers = new Map<string, fs.FSWatcher>(); // dir → watcher
const DEBOUNCE_MS = 600; // CLI 高频 append 合并窗口
// 去抖的封顶：持续写入的 transcript（存活的 codex rollout 每 10s 就 +60KB）会让
// 纯 trailing 去抖要么每个窗口都触发一次解析、要么被无限延后。封顶 = 从**第一次**
// 事件算起最多等这么久就一定解析一次，之后重新计窗。
const MAX_DEBOUNCE_WAIT_MS = 5000;

type PendingSync = {
  timer: NodeJS.Timeout | null;
  firstEventAt: number;
  running: boolean;
  dirtyWhileRunning: boolean;
};
const pending = new Map<string, PendingSync>(); // file → 去抖状态

async function turnIdsForSession(
  trellisSessionId: string,
  provider: CliProvider,
): Promise<Set<string>> {
  const db = getDB();
  const rows = db
    .prepare("SELECT jsonl_path AS p FROM cli_lineages WHERE trellis_session_id = ?")
    .all(trellisSessionId) as { p: string }[];
  const ids = new Set<string>();
  for (const r of rows) {
    const parsed = await parseCliTranscriptAsync(provider, r.p);
    if (!parsed) continue;
    for (const t of parsed.turns) ids.add(t.id);
  }
  return ids;
}

async function attachNewForkIfMatched(
  full: string,
  provider: CliProvider,
): Promise<ImportResult | null> {
  const parsed = await parseCliTranscriptAsync(provider, full);
  if (!parsed || parsed.turns.length === 0) return null;
  const candidateIds = new Set(parsed.turns.map((t) => t.id));
  const sessionIds = attachedSessions().filter(
    (session) =>
      session.provider === provider &&
      (provider !== "codex" || session.cwd === parsed.cwd),
  );
  let best: { sid: string; shared: number; ids: Set<string> } | null = null;
  for (const session of sessionIds) {
    const ids = await turnIdsForSession(session.id, provider);
    let shared = 0;
    for (const id of candidateIds) if (ids.has(id)) shared++;
    if (shared > 0 && (!best || shared > best.shared)) {
      best = { sid: session.id, shared, ids };
    }
  }
  if (!best) return null;

  const firstUnique = [...parsed.turns]
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .find((t) => !best!.ids.has(t.id));
  const forkPointUuid = firstUnique?.parentId ?? null;
  const db = getDB();
  db.prepare(
    `INSERT INTO cli_lineages
       (trellis_session_id, cli_session_id, provider_family, jsonl_path,
        fork_point_uuid, is_root, synced_uuid)
     VALUES (?, ?, ?, ?, ?, 0, NULL)
     ON CONFLICT(trellis_session_id, cli_session_id) DO UPDATE SET
       provider_family = excluded.provider_family,
       jsonl_path = excluded.jsonl_path,
       fork_point_uuid = excluded.fork_point_uuid`,
  ).run(best.sid, parsed.sessionId, provider, full, forkPointUuid);
  return importCliLineageAsync(best.sid);
}

// ── reimport 失败的出口分流（S177 P1）────────────────────────────────────────
//
// 单文件失败不掀翻 watcher —— 但绝不能连声都不吭。reimport 是镜像会话唯一的更新
// 通道，它一失败界面就永久停在旧快照上，用户看到的只是一个不再动的 turn，
// 无从判断「是 CLI 还没写」还是「同步早就死了」。
//
// 出口按**错误类别**分，不按「有没有异常」分：
//   busy（含 LOCKED）  瞬时争用，下一轮 debounce 自然重来 → 只 warn。绝不告警：
//                      多个 CLI 同时写 jsonl 时 BUSY 是常态，每次都推等于自造噪声。
//   full / io /        盘满、IO 错、只读挂载、库损坏 —— 重试一百次也是同一个结果，
//   readonly / corrupt 必须惊动人 → 告警通道（notify）+ cli-sync 事件。
//   unknown / other    其它 DB 错（约束冲突等）与非 DB 异常（解析、发现阶段）——
//                      是 bug 不是环境事故，推事件让界面能显示「同步失败」，
//                      但不 notify。
//
// 判据用 db-error 的 classifyDbError / isDbFailure：**不能只判 instanceof
// DbWriteError**。importCliLineage 的事务还没纳入 dbWrite（P2 待办），禁区里原始的
// SQLiteError 会直接抛上来，`instanceof` 那种判据会整个漏掉。
const FAILURE_ALERT_KINDS = new Set<SqliteFailureKind>([
  "full",
  "io",
  "readonly",
  "corrupt",
]);

// 去重形状照抄 disk-watch.ts 的 checkDiskAlert：Record<key, ts> + 冷却 + **边沿**
// （恢复一次就清账，下次再坏可以重新报）。差别只在存储：这是 600ms 级的热路径，
// 每次失败都读写一个 json 文件不划算，状态因此留在进程内存里 —— cli-sync 失败
// 本来就是 watcher 进程的运行期状态，重启后重新评估正是我们要的。
const ALERT_COOLDOWN_MS = 6 * 3600_000; // 同 disk-watch：一直不修就每 6h 再提醒一次
const EVENT_COOLDOWN_MS = 30_000; // 事件比告警灵敏，只压掉一阵子里的同类重复
const alertState: Record<string, number> = {};
const eventState: Record<string, number> = {};

/** 过闸则记账返回 true；冷却期内返回 false。 */
function passesGate(
  state: Record<string, number>,
  key: string,
  now: number,
  cooldownMs: number,
): boolean {
  const last = state[key];
  if (last !== undefined && now - last < cooldownMs) return false;
  state[key] = now;
  return true;
}

function clearGate(state: Record<string, number>): void {
  for (const key of Object.keys(state)) delete state[key];
}

function failureMessage(kind: SqliteFailureKind | "other", err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  switch (kind) {
    case "full":
      return `CLI 会话同步失败：数据库磁盘空间不足。${raw}`;
    case "io":
      return `CLI 会话同步失败：磁盘 I/O 错误。${raw}`;
    case "readonly":
      return `CLI 会话同步失败：数据库当前不可写。${raw}`;
    case "corrupt":
      return `CLI 会话同步失败：数据库文件可能已损坏。${raw}`;
    default:
      return `CLI 会话同步失败：${raw}`;
  }
}

export type CliSyncFailureDeps = {
  now?: () => number;
  alertState?: Record<string, number>;
  eventState?: Record<string, number>;
  send?: (e: { title: string; body: string }) => Promise<void> | void;
  publish?: (failure: CliSyncFailure) => void;
  log?: (message: string, ...rest: unknown[]) => void;
};

export type ReimportFailureOutcome = {
  kind: SqliteFailureKind | "other";
  /** retry = 瞬时，等下一轮；surfaced = 已推事件（alerted 再叠加了告警通道）。 */
  exit: "retry" | "surfaced";
  alerted: boolean;
  published: boolean;
};

/** 把一次 reimport 失败送到它该去的出口。自兜异常 —— 汇报本身绝不能再掀翻 watcher。 */
export async function reportReimportFailure(
  full: string,
  sessionId: string | null,
  err: unknown,
  deps: CliSyncFailureDeps = {},
): Promise<ReimportFailureOutcome> {
  const kind: SqliteFailureKind | "other" = isDbFailure(err)
    ? classifyDbError(err)
    : "other";
  const log = deps.log ?? ((m: string, ...rest: unknown[]) => console.error(m, ...rest));

  if (kind !== "other" && isTransientKind(kind)) {
    log(`[trellis] cli-sync reimport busy (${full})，下一轮重试：`, err);
    return { kind, exit: "retry", alerted: false, published: false };
  }

  const now = (deps.now ?? Date.now)();
  const message = failureMessage(kind, err);
  log(`[trellis] cli-sync reimport failed (${kind}): ${full}`, err);

  let published = false;
  const events = deps.eventState ?? eventState;
  if (passesGate(events, `${sessionId ?? full}:${kind}`, now, EVENT_COOLDOWN_MS)) {
    try {
      (deps.publish ?? publishCliSyncFailed)({ path: full, sessionId, kind, message });
      published = true;
    } catch (e) {
      log("[trellis] cli-sync 失败事件推送失败：", e);
    }
  }

  let alerted = false;
  const alerts = deps.alertState ?? alertState;
  // 告警按**类别**去重，不按文件：盘一满，几十个 attached 文件会同时失败，
  // 按文件去重等于给用户发几十条一模一样的告警。
  if (
    kind !== "other" &&
    FAILURE_ALERT_KINDS.has(kind) &&
    passesGate(alerts, kind, now, ALERT_COOLDOWN_MS)
  ) {
    const title = "trellis：CLI 会话同步失败";
    const body =
      `${message}\n源文件：${full}` +
      (sessionId ? `\n镜像会话：${sessionId}` : "") +
      `\n同步已停在旧快照上，修好前界面不会再更新。`;
    try {
      if (deps.send) await deps.send({ title, body });
      else await notify({ kind: "disk_alert", title, body });
      alerted = true;
    } catch (e) {
      log("[trellis] cli-sync 告警发送失败：", e);
    }
  }

  return { kind, exit: "surfaced", alerted, published };
}

/** 一次**真的写进去了**的 reimport = 故障已恢复，清账让下次失败重新报（边沿）。 */
export function noteReimportSuccess(deps: CliSyncFailureDeps = {}): void {
  clearGate(deps.alertState ?? alertState);
  clearGate(deps.eventState ?? eventState);
}

// 异步：解析走 importCliLineageAsync / parseCliTranscriptAsync 的分片让出路径
// （fix-b），失败出口走上面的分流（d2）。两者互不相干，都保留。
export async function reimport(full: string): Promise<void> {
  if (!fs.existsSync(full)) return; // 被删/改名
  const pathMap = attachedPathMap();
  const attached = pathMap.get(full);
  const provider: CliProvider =
    attached?.provider ?? (isWithinCodexSessions(full) ? "codex" : "claude");
  try {
    const res = attached
      ? await importCliLineageAsync(attached.sid)
      : await attachNewForkIfMatched(full, provider);
    // 只有真的落了盘才算「故障已恢复」。null（没匹配上任何 attached 会话）、
    // unchanged / empty / skipped-native 都在事务之前就返回了，一个字节没写，
    // 证明不了 DB 还写得进去，不能拿来清告警账。
    if (res && (res.status === "updated" || res.status === "imported")) {
      noteReimportSuccess();
      publishCliSessionUpdated(res.sessionId);
    }
  } catch (err) {
    void reportReimportFailure(full, attached?.sid ?? null, err).catch(() => {});
  }
}

// 去抖 + 合流。对**持续写入**的文件，纯 trailing 去抖（每次事件重置计时器）有两
// 个坏结局：写入不停时窗口被无限延后（界面永远不更新），或者窗口刚好够触发时
// 每隔 600ms 就重解析一次（就是这次要修的 CPU 尖峰）。所以：
//   · trailing-only —— 事件流里不解析，安静下来才解析一次；
//   · 封顶 MAX_DEBOUNCE_WAIT_MS —— 再吵也保证这个周期内解析一次，不饿死 UI；
//   · 解析进行中到来的事件只标脏，等这次跑完再排一次，绝不并发叠加。
function scheduleReimport(full: string): void {
  let state = pending.get(full);
  if (!state) {
    state = {
      timer: null,
      firstEventAt: Date.now(),
      running: false,
      dirtyWhileRunning: false,
    };
    pending.set(full, state);
  }
  if (state.running) {
    state.dirtyWhileRunning = true;
    return;
  }
  const waited = Date.now() - state.firstEventAt;
  const delay = Math.max(0, Math.min(DEBOUNCE_MS, MAX_DEBOUNCE_WAIT_MS - waited));
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => void runPendingReimport(full), delay);
}

async function runPendingReimport(full: string): Promise<void> {
  const state = pending.get(full);
  if (!state) return;
  state.timer = null;
  state.running = true;
  state.dirtyWhileRunning = false;
  try {
    await reimport(full);
  } finally {
    state.running = false;
    if (state.dirtyWhileRunning) {
      state.dirtyWhileRunning = false;
      state.firstEventAt = Date.now();
      scheduleReimport(full);
    } else {
      pending.delete(full);
    }
  }
}

function watchDir(dir: string, recursive = false): void {
  if (watchers.has(dir)) return;
  let w: fs.FSWatcher;
  try {
    w = fs.watch(dir, { recursive }, (_event, filename) => {
      if (!filename || !filename.toString().endsWith(".jsonl")) return;
      scheduleReimport(path.join(dir, filename.toString()));
    });
  } catch {
    return; // 目录不可 watch
  }
  w.on("error", () => {
    w.close();
    watchers.delete(dir);
  });
  watchers.set(dir, w);
}

// 按当前 attached 集合重算要监听的目录，增删 watcher（attach/detach 后调）。
export function refreshWatches(): void {
  const pathMap = attachedPathMap();
  const wantDirs = new Set([...pathMap.keys()].map((p) => path.dirname(p)));
  // `codex fork` can write the new rollout under today's YYYY/MM/DD instead
  // of beside an older source thread. A recursive root watch lets the normal
  // shared-turn matcher register that new lineage. Keep the concrete day
  // watches too: they are the portable fallback where recursive fs.watch is
  // unsupported, and duplicate events collapse through the per-file debounce.
  if ([...pathMap.values()].some((entry) => entry.provider === "codex")) {
    wantDirs.add(CODEX_SESSIONS_DIR);
  }
  for (const d of wantDirs) watchDir(d, d === CODEX_SESSIONS_DIR);
  for (const d of [...watchers.keys()]) {
    if (!wantDirs.has(d)) {
      watchers.get(d)!.close();
      watchers.delete(d);
    }
  }
}

// ── 对外操作 ─────────────────────────────────────────────────────────────────

// 同步形态。**只剩用户在界面上手点 attach 这一条调用方**（app/api/cli-sync/attach）：
// 那是一次交互式请求，用户就在等这个响应，占一会儿主线程是可接受的代价。
// herdr 的自动 attach 走下面的异步形态 —— 它是后台批量重放，不能占住事件循环。
export function attachSession(
  jsonlPath: string,
  provider: CliProvider = "claude",
  options: { origin?: MirrorOrigin } = {},
): ImportResult {
  // canonical，不是 path.resolve：attach 入口拿到的可能是 herdr 侧 realpath 过的
  // 物理路径，也可能是 $HOME 符号前缀的路径，往下要和枚举侧比串（根因 C）。
  const resolved = canonicalPath(jsonlPath);
  const state = classifyRootTranscript(provider, resolved);
  if (state.kind === "unreadable") {
    throw new CliTranscriptUnreadableError(resolved);
  }
  // 空会话在这里短路。往下 discoverLineage 会把同目录所有 jsonl 解析一遍 ——
  // 那正是「永久重试空会话」把 prod 主线程烧到 100% CPU 的地方。
  if (state.kind === "empty") {
    return { sessionId: state.sessionId, status: "empty", turns: 0 };
  }
  const lineage = discoverLineage(resolved, provider);
  seedLineage(lineage, provider, lineage.rootSid, options.origin ?? "cli-import");
  const res = importCliLineage(lineage.rootSid);
  refreshWatches();
  return res;
}

/**
 * attachSession 的非阻塞形态 —— **herdr-fleet 的自动 attach 走这条**（根因 D）。
 *
 * 现场：fix-b 的异步化只覆盖了启动补齐与 watcher 的 reimport，herdr 首次 attach
 * 仍是同步全量 parse。devbox 上单个 rollout 最大 1.28GB，首次 attach 一次阻塞
 * 主线程数十秒；而 fleet 每 60s snapshot 都会把同一批 transcript 重放一遍。
 *
 * 四段全部换成让出路径：
 *   classify  classifyCliTranscriptAsync（分片解析 + 分片定性）
 *   discover  discoverLineageAsync（分片解析 + 枚举缓存 + 兄弟循环让出）
 *   seed      seedLineageAsync（定性分片；DB 落地与同步版同一段代码）
 *   import    importCliLineageAsync（fix-b 已有）
 *
 * **失败语义与同步版逐字相同**，这是硬要求：链尾是 herdr-fleet 的重试闸，它按
 * 错误**类型**分流（isDeterministicAttachFailure），换成 Promise 只是换了传递
 * 方式 —— reject 的还是 CliTranscriptUnreadableError（可重试）/
 * CliTranscriptNoTurnsError、NativeSessionConflictError（确定性，按指纹跳过），
 * 绝不能退化成裸 Error 或被吞掉。
 */
export async function attachSessionAsync(
  jsonlPath: string,
  provider: CliProvider = "claude",
  options: { origin?: MirrorOrigin } = {},
): Promise<ImportResult> {
  const resolved = canonicalPath(jsonlPath);
  const state = await classifyCliTranscriptAsync(provider, resolved);
  if (state.kind === "unreadable") {
    throw new CliTranscriptUnreadableError(resolved);
  }
  if (state.kind === "empty") {
    return { sessionId: state.sessionId, status: "empty", turns: 0 };
  }
  const lineage = await discoverLineageAsync(resolved, provider);
  await seedLineageAsync(
    lineage,
    provider,
    lineage.rootSid,
    options.origin ?? "cli-import",
  );
  const res = await importCliLineageAsync(lineage.rootSid);
  refreshWatches();
  return res;
}

// detach = 删 trellis 侧 session（origin='cli-import' 闸保证不删原始 jsonl）+ 停 watch。
export function detachSession(sessionId: string): void {
  deleteSession(sessionId);
  refreshWatches();
}

// ── 启动（instrumentation register）──────────────────────────────────────────

let started = false;

export function startCliSyncWatcher(): void {
  if (started) return;
  started = true;
  // Observe changes immediately; offline catchup must not hold instrumentation
  // (and every first HTTP request) behind all persisted transcript histories.
  void catchUpAttachedSessions();
}

async function catchUpAttachedSessions(): Promise<void> {
  try {
    // Heal moved Codex rollout paths before the startup re-import reads them.
    attachedPathMap();
    refreshWatches();
    // 启动时补齐进程离线期间的变更，监听先建立以免漏掉补齐期间的新写入。
    for (const session of attachedSessions()) {
      // Yield between per-session imports, including before the first one.
      // A single deferred callback around the whole loop still blocks the
      // event loop for the sum of all transcript parsing times. (每段解析自己
      // 也分片让出了，但每个会话之间仍要让一次：discover / seed / import 三段之
      // 间还有纯同步的 DB 工作。)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      let rootPath = "";
      try {
        const db = getDB();
        const root = db
          .prepare(
            `SELECT jsonl_path AS p
             FROM cli_lineages
             WHERE trellis_session_id = ? AND is_root = 1
             LIMIT 1`,
          )
          .get(session.id) as { p: string } | undefined;
        if (root?.p) {
          rootPath = root.p;
          // 发现与 seed 也走让出路径：光把 import 异步化，整轮补齐仍会被
          // 「N 个会话 × 一次同步全树发现 + 一次同步全量定性」占住（根因 D）。
          await seedLineageAsync(
            await discoverLineageAsync(root.p, session.provider),
            session.provider,
            session.id,
          );
        }
        const res = await importCliLineageAsync(session.id);
        if (res.status === "updated" || res.status === "imported") {
          noteReimportSuccess();
          publishCliSessionUpdated(res.sessionId);
        }
      } catch (err) {
        // 单文件失败不影响其余 —— 但同样要走出口分流。启动补齐撞上盘满时
        // 原先是彻底静默的，整轮镜像停在旧快照而没有任何痕迹。
        await reportReimportFailure(rootPath, session.id, err).catch(() => {});
      }
    }
    refreshWatches();
  } catch {
    // DB 未就绪等极端情况，下次启动再说
  }
}
