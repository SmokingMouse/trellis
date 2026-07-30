// CLI session 实时同步 watcher（per-session attach 模型，progress/cli-sync.md）。
// 用户 attach 的 CLI 会话 = origin='cli-import' 且带 source_jsonl_path 的 trellis session。
// watcher 监听这些 jsonl 所在目录，文件变更 → debounce → 重导入对应 attached 会话。
// 只同步 attached 的文件，目录里其它会话一概不碰（per-session，不是 per-dir 灌）。
// 启动点：instrumentation.ts register()，每进程一次。
import "server-only";
import fs from "node:fs";
import path from "node:path";
import { getDB } from "./sqlite";
import { importCliLineage, type ImportResult } from "./cli-import-db";
import { ensureWorkspaceForPath } from "./workspaces";
import { parseCliSessionJsonl } from "./cli-import";
import { discoverLineage, type DiscoveredLineage } from "./cli-discover";
import { deleteSession } from "./repo";
import { publishCliSessionUpdated } from "./cli-sync-events";

// 当前 attached 会话的源 jsonl 绝对路径集合（每次实时查 DB，保持权威）。
function attachedPathMap(): Map<string, string> {
  const db = getDB();
  const rows = db
    .prepare(
      `SELECT trellis_session_id AS sid, jsonl_path AS p
       FROM cli_lineages
       WHERE jsonl_path IS NOT NULL`,
    )
    .all() as { sid: string; p: string }[];
  return new Map(rows.map((r) => [r.p, r.sid]));
}

function attachedPaths(): Set<string> {
  return new Set(attachedPathMap().keys());
}

function attachedSessionIds(): string[] {
  const db = getDB();
  const rows = db
    .prepare("SELECT id FROM sessions WHERE origin = 'cli-import'")
    .all() as { id: string }[];
  return rows.map((r) => r.id);
}

function seedLineage(discovered: DiscoveredLineage, trellisSessionId = discovered.rootSid): void {
  const db = getDB();
  const root = discovered.members.find((m) => m.isRoot) ?? discovered.members[0];
  const parsed = parseCliSessionJsonl(root.path);
  if (!parsed || parsed.turns.length === 0) {
    throw new Error("root CLI jsonl has no parseable turns");
  }
  const existing = db
    .prepare("SELECT origin FROM sessions WHERE id = ?")
    .get(trellisSessionId) as { origin: string } | undefined;
  if (existing && existing.origin !== "cli-import") {
    throw new Error(`session id ${trellisSessionId} already exists as native session`);
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
          workspace_path, workspace_id, origin, source_jsonl_path, synced_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'cli-import', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         root_node_id = excluded.root_node_id,
         updated_at = excluded.updated_at,
         workspace_path = excluded.workspace_path,
         workspace_id = COALESCE(excluded.workspace_id, sessions.workspace_id),
         source_jsonl_path = excluded.source_jsonl_path,
         synced_uuid = excluded.synced_uuid`,
    ).run(
      trellisSessionId,
      parsed.title,
      rootNodeId,
      parsed.createdAt,
      parsed.updatedAt,
      mode,
      parsed.cwd,
      workspaceId,
      root.path,
      parsed.lastUuid,
    );

    db.prepare("UPDATE cli_lineages SET is_root = 0 WHERE trellis_session_id = ?").run(
      trellisSessionId,
    );
    const upsertLineage = db.prepare(
      `INSERT INTO cli_lineages
         (trellis_session_id, claude_session_id, jsonl_path, fork_point_uuid, is_root, synced_uuid)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(trellis_session_id, claude_session_id) DO UPDATE SET
         jsonl_path = excluded.jsonl_path,
         fork_point_uuid = excluded.fork_point_uuid,
         is_root = excluded.is_root`,
    );
    for (const m of discovered.members) {
      upsertLineage.run(
        trellisSessionId,
        m.sid,
        m.path,
        m.forkPointUuid,
        m.isRoot ? 1 : 0,
      );
    }
  });
  tx();
}

const watchers = new Map<string, fs.FSWatcher>(); // dir → watcher
const debounce = new Map<string, NodeJS.Timeout>(); // file → timer
const DEBOUNCE_MS = 600; // CLI 高频 append 合并窗口

function turnIdsForSession(trellisSessionId: string): Set<string> {
  const db = getDB();
  const rows = db
    .prepare("SELECT jsonl_path AS p FROM cli_lineages WHERE trellis_session_id = ?")
    .all(trellisSessionId) as { p: string }[];
  const ids = new Set<string>();
  for (const r of rows) {
    const parsed = parseCliSessionJsonl(r.p);
    if (!parsed) continue;
    for (const t of parsed.turns) ids.add(t.id);
  }
  return ids;
}

function attachNewForkIfMatched(full: string): ImportResult | null {
  const parsed = parseCliSessionJsonl(full);
  if (!parsed || parsed.turns.length === 0) return null;
  const candidateIds = new Set(parsed.turns.map((t) => t.id));
  const sessionIds = attachedSessionIds();
  let best: { sid: string; shared: number; ids: Set<string> } | null = null;
  for (const sid of sessionIds) {
    const ids = turnIdsForSession(sid);
    let shared = 0;
    for (const id of candidateIds) if (ids.has(id)) shared++;
    if (shared > 0 && (!best || shared > best.shared)) {
      best = { sid, shared, ids };
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
       (trellis_session_id, claude_session_id, jsonl_path, fork_point_uuid, is_root, synced_uuid)
     VALUES (?, ?, ?, ?, 0, NULL)
     ON CONFLICT(trellis_session_id, claude_session_id) DO UPDATE SET
       jsonl_path = excluded.jsonl_path,
       fork_point_uuid = excluded.fork_point_uuid`,
  ).run(best.sid, parsed.sessionId, full, forkPointUuid);
  return importCliLineage(best.sid);
}

export function reimport(full: string): void {
  if (!fs.existsSync(full)) return; // 被删/改名
  const pathMap = attachedPathMap();
  const sid = pathMap.get(full);
  try {
    const res = sid ? importCliLineage(sid) : attachNewForkIfMatched(full);
    if (res && (res.status === "updated" || res.status === "imported")) {
      publishCliSessionUpdated(res.sessionId);
    }
  } catch (err) {
    // 单文件失败不掀翻 watcher —— 但绝不能连声都不吭。这是镜像会话唯一的更新
    // 通道，它一失败界面就永久停在旧快照上，而用户看到的只是一个不再动的 turn。
    // 无日志的话根本无从判断「是 CLI 还没写」还是「同步早就死了」。
    console.error("[trellis] cli-sync reimport failed:", full, err);
  }
}

function watchDir(dir: string): void {
  if (watchers.has(dir)) return;
  let w: fs.FSWatcher;
  try {
    w = fs.watch(dir, (_event, filename) => {
      if (!filename || !filename.toString().endsWith(".jsonl")) return;
      const full = path.join(dir, filename.toString());
      const prev = debounce.get(full);
      if (prev) clearTimeout(prev);
      debounce.set(
        full,
        setTimeout(() => {
          debounce.delete(full);
          reimport(full);
        }, DEBOUNCE_MS),
      );
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
  const wantDirs = new Set(
    [...attachedPaths()].map((p) => path.dirname(p)),
  );
  for (const d of wantDirs) watchDir(d);
  for (const d of [...watchers.keys()]) {
    if (!wantDirs.has(d)) {
      watchers.get(d)!.close();
      watchers.delete(d);
    }
  }
}

// ── 对外操作 ─────────────────────────────────────────────────────────────────

export function attachSession(jsonlPath: string) {
  const lineage = discoverLineage(jsonlPath);
  seedLineage(lineage);
  const res = importCliLineage(lineage.rootSid);
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
  try {
    // 启动时补一次全量重导（捕获进程不在时 CLI 侧的离线变更），再起 watch。
    for (const sid of attachedSessionIds()) {
      try {
        const db = getDB();
        const root = db
          .prepare(
            `SELECT jsonl_path AS p
             FROM cli_lineages
             WHERE trellis_session_id = ? AND is_root = 1
             LIMIT 1`,
          )
          .get(sid) as { p: string } | undefined;
        if (root?.p) {
          seedLineage(discoverLineage(root.p), sid);
        }
        const res = importCliLineage(sid);
        if (res.status === "updated" || res.status === "imported") {
          publishCliSessionUpdated(res.sessionId);
        }
      } catch {
        /* 单文件失败不影响其余 */
      }
    }
    refreshWatches();
  } catch {
    // DB 未就绪等极端情况，下次启动再说
  }
}
