import "server-only";
import { sessionSourcePredicate } from "../session-source";
import fs from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { getDB } from "./sqlite";
import { uuid } from "@/lib/uuid";
import {
  clusterPath,
  gitCommonDirOf,
  listSiblingWorktrees,
  listSiblingWorktreesAsync,
} from "./project-cluster";

// S1（progress/project-workspace-layer.md）：Project → Workspace 的读写层。
//
// 与 sessions 的关系刻意是「弱绑定」：workspace_id 只是归属指针，
// sessions.workspace_path 仍是 spawn cwd 的唯一真源。所以这一层任何失败
// （目录消失、git 不可用）都只让 session 落到「未归组」，绝不影响它能否跑。

export interface ApiWorkspace {
  id: string;
  projectId: string;
  name: string;
  path: string;
  kind: string;
  gitBranch: string | null;
  createdBy: string;
  lastUsedAt: number | null;
  sessionCount: number;
}

export interface ApiProject {
  id: string;
  name: string;
  clusterKey: string;
  gitRemote: string | null;
  workspaces: ApiWorkspace[];
}

type ProjectRow = {
  id: string;
  name: string;
  cluster_key: string;
  git_remote: string | null;
};

type WorkspaceRow = {
  id: string;
  project_id: string;
  name: string;
  path: string;
  kind: string;
  git_branch: string | null;
  created_by: string;
  last_used_at: number | null;
};

/**
 * 路径存在性的短 TTL 缓存。
 *
 * `listProjectTree` 是**同步**函数，且挂在 `/api/sessions` 上 —— 侧栏的 fetch
 * 依赖里有 `sessionsRevision`，而 cli-sync 的 600ms 合并窗口会让它在流式期间
 * 达到 ~1.6 次/秒。本地盘上 `existsSync` 是微秒级、无所谓；但未挂载的网络盘
 * （NFS/SMB）上 stat 能阻塞到秒级，那样一个卡住的挂载点就足以冻住整个 server。
 * TTL 把最坏情况摊薄成每 5 秒一次。
 */
const EXISTS_TTL_MS = 5_000;
const existsCache = new Map<string, { at: number; ok: boolean }>();

function pathExists(p: string): boolean {
  const hit = existsCache.get(p);
  const now = Date.now();
  if (hit && now - hit.at < EXISTS_TTL_MS) return hit.ok;
  const ok = fs.existsSync(p);
  existsCache.set(p, { at: now, ok });
  return ok;
}

/**
 * 新建 / 删除 worktree 之后立刻让缓存失效，别等 TTL 到期。
 *
 * 缓存必须可失效 —— `fba0d28` 修的就是「ttyd 探测失败被永久缓存」，
 * 一次瞬时结果焊死到进程重启。同一个坑不踩两次。
 */
export function invalidatePathExists(p?: string): void {
  if (p) existsCache.delete(p);
  else existsCache.clear();
}

/** `created_by` 的权限序：越大越有资格删磁盘。 */
const ORIGIN_RANK: Record<string, number> = {
  discovered: 0,
  "worktree-scan": 1,
  trellis: 2,
};

/**
 * workspace 的持久身份是磁盘真实路径，而不是调用方传来的路径拼写。
 *
 * macOS 上 `/tmp` 与 `/private/tmp`、以及任意 symlink 都可能指向同一目录；
 * realpath 收敛这些别名。目录已经消失时不能臆造身份，保留原串交给调用方
 * 既有的「不存在」分支处理。
 */
export function canonicalWorkspacePath(absPath: string): string {
  try {
    return fs.realpathSync(absPath);
  } catch {
    return absPath;
  }
}

/**
 * 启动期存量迁移：把同一 realpath 的 workspace 合并，并统一成 canonical path。
 *
 * keeper 先按 created_by 权限序选最高者，同权限时优先保留已经挂会话的行；
 * 所有会话先改指针再删重复行。函数不写迁移标记，重复运行自然是 no-op。
 */
export function mergeDuplicateWorkspacePaths(db: Database): {
  merged: number;
  normalized: number;
} {
  type MigrationRow = WorkspaceRow & { created_at: number; session_count: number };
  const rows = db
    .prepare(
      `SELECT w.id, w.project_id, w.name, w.path, w.kind, w.git_branch,
              w.created_by, w.last_used_at, w.created_at,
              COUNT(s.id) AS session_count
         FROM workspaces w
         LEFT JOIN sessions s ON s.workspace_id = w.id
        GROUP BY w.id`,
    )
    .all() as MigrationRow[];
  const groups = new Map<string, MigrationRow[]>();
  for (const row of rows) {
    const canonical = canonicalWorkspacePath(row.path);
    const group = groups.get(canonical) ?? [];
    group.push(row);
    groups.set(canonical, group);
  }

  let merged = 0;
  let normalized = 0;
  const migrate = db.transaction(() => {
    for (const [canonical, group] of groups) {
      group.sort((a, b) => {
        const byOrigin =
          (ORIGIN_RANK[b.created_by] ?? 0) - (ORIGIN_RANK[a.created_by] ?? 0);
        if (byOrigin !== 0) return byOrigin;
        const bySessions = Number(b.session_count > 0) - Number(a.session_count > 0);
        if (bySessions !== 0) return bySessions;
        const byCreated = a.created_at - b.created_at;
        return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
      });
      const keeper = group[0];
      if (!keeper) continue;
      for (const duplicate of group.slice(1)) {
        db.prepare("UPDATE sessions SET workspace_id = ? WHERE workspace_id = ?").run(
          keeper.id,
          duplicate.id,
        );
        db.prepare("DELETE FROM workspaces WHERE id = ?").run(duplicate.id);
        merged++;
      }
      if (keeper.path !== canonical) {
        db.prepare("UPDATE workspaces SET path = ? WHERE id = ?").run(
          canonical,
          keeper.id,
        );
        normalized++;
      }
    }
  });
  migrate();
  return { merged, normalized };
}

/** 清掉旧版扫描登记时伪造的「最近使用」时间；重复运行不会再命中。 */
export function clearScanRegistrationRecency(db: Database): number {
  const result = db
    .prepare(
      `UPDATE workspaces
          SET last_used_at = NULL
        WHERE created_by = 'worktree-scan'
          AND last_used_at = created_at`,
    )
    .run();
  return Number(result.changes ?? 0);
}

/**
 * 把一个绝对路径解析成 workspace（必要时连带建 project），返回 workspace id。
 *
 * 幂等：同一个 path 反复调用返回同一行。路径无法归类（不存在 / 不是目录）
 * 返回 null —— 调用方把 session 留在未归组即可，**不要因此让创建会话失败**。
 *
 * createdBy: 'discovered' = 从既有目录发现（只能移除、不能删磁盘）；
 *            'trellis'    = trellis 自己 `git worktree add` 造的（可删）。
 */
export type WorkspaceOrigin =
  /** 从既有 session 的目录发现 —— 只能移除，不能删磁盘 */
  | "discovered"
  /** `git worktree list` 扫出来的兄弟 worktree，可能一个 session 都没有 */
  | "worktree-scan"
  /** trellis 自己 `git worktree add` 造的 —— 可以删磁盘（P2） */
  | "trellis";

export function ensureWorkspaceForPath(
  absPath: string,
  createdBy: WorkspaceOrigin = "discovered",
  db: Database = getDB(),
): string | null {
  const canonicalPath = canonicalWorkspacePath(absPath);
  // 快路径：已登记过的目录直接返回，**一个 git 子进程都不 spawn**。
  // 这条路径必须便宜 —— cli-sync-watcher 每次 jsonl 变动都会走到这里
  // （流式期间每秒多次），在那里 spawn git 是不可接受的。
  // 代价：git_branch 只在首次登记与启动扫描时刷新。P0 不显示分支，
  // P2 加 git 状态角标时会带自己的轮询刷新。
  const existing = db
    .prepare("SELECT id, created_by FROM workspaces WHERE path = ?")
    .get(canonicalPath) as { id: string; created_by: string } | undefined;
  if (existing) {
    // 命中已有行时，把 created_by 往权限更大的方向提升（只升不降）。
    // 场景：CLI 里建的 worktree 先被扫描登记成 'worktree-scan'，用户删掉后
    // 又从 trellis UI 重建同名的 —— 不提升的话这行永远是 'worktree-scan'，
    // 而删除按钮只认 'trellis'，于是 trellis 自己建的 worktree 反而删不掉。
    //
    // 高频路径（cli-sync-watcher）传的是默认 'discovered'（rank 0），
    // 永远进不了这个分支，所以快路径依旧是纯 SELECT、零额外写。
    if ((ORIGIN_RANK[createdBy] ?? 0) > (ORIGIN_RANK[existing.created_by] ?? 0)) {
      db.prepare("UPDATE workspaces SET created_by = ? WHERE id = ?").run(
        createdBy,
        existing.id,
      );
    }
    return existing.id;
  }

  const cluster = clusterPath(canonicalPath);
  // 目录不存在 / 归不了类 → 不为它建行，调用方留在未归组。
  if (!cluster) return null;

  const now = Date.now();

  // project：按 cluster_key 幂等 upsert。名字只在首次创建时写 —— 用户改过名
  // 之后不该被下一次发现覆盖回默认值。
  db.prepare(
    `INSERT INTO projects (id, name, cluster_key, git_remote, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(cluster_key) DO UPDATE SET
       updated_at = excluded.updated_at,
       git_remote = COALESCE(projects.git_remote, excluded.git_remote)`,
  ).run(uuid(), cluster.projectName, cluster.clusterKey, cluster.gitRemote, now, now);

  const project = db
    .prepare("SELECT id FROM projects WHERE cluster_key = ?")
    .get(cluster.clusterKey) as { id: string };

  // ON CONFLICT 是必需的：SELECT 快路径与这条 INSERT 之间存在窗口，而兄弟
  // worktree 重扫从 boot-only 改成按需触发后就有了并发调用者，撞上同一个
  // path 会直接抛 UNIQUE 约束错误、把整个请求带崩。
  db.prepare(
    `INSERT INTO workspaces
       (id, project_id, name, path, kind, git_branch, created_by, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO NOTHING`,
  ).run(
    uuid(),
    project.id,
    cluster.workspaceName,
    canonicalPath,
    cluster.kind,
    cluster.gitBranch,
    createdBy,
    now,
    createdBy === "trellis" ? now : null,
  );
  // 冲突时上面那个 uuid 没被写进去，必须回查真正落库的 id。
  const row = db
    .prepare("SELECT id FROM workspaces WHERE path = ?")
    .get(canonicalPath) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * 把 absPath 所属 repo 的所有兄弟 worktree 登记进来（幂等）。
 *
 * 这些行 created_by='worktree-scan' —— 即使还没有任何 session 也要显示在侧栏，
 * 否则「这个项目有哪几条并行分支」永远不可见，用户就不会想到在里面开会话。
 * 不影响已存在的行（ensureWorkspaceForPath 内部只刷分支、不覆盖 created_by）。
 */
export function registerSiblingWorktrees(
  absPath: string,
  db: Database = getDB(),
): { added: number; pruned: number } {
  return registerWorktreeList(listSiblingWorktrees(absPath), db);
}

/** 登记 + 清理的 DB 部分，与「怎么拿到 live 列表」解耦（同步版 / 异步版共用）。 */
function registerWorktreeList(
  rawLive: string[],
  db: Database,
): { added: number; pruned: number } {
  const live = normalizeLive(rawLive);
  let added = 0;
  for (const p of live) {
    if (isRegistered(p, db)) continue;
    if (ensureWorkspaceForPath(p, "worktree-scan", db)) added++;
  }
  return { added, pruned: pruneVanishedWorktrees(live, db) };
}

/**
 * `registerWorktreeList` 的异步版：每登记一个**新**路径就让出一次事件循环。
 *
 * 为什么需要：登记走 `ensureWorkspaceForPath` → `clusterPath`，那条链至今仍是
 * 同步的（rev-parse / branch / remote 各一次 spawnSync）。它只对「DB 里还没有
 * 的路径」发生，但一个上百 worktree 的大仓第一次扫起来就是上百次 × 4 —— 连着
 * 跑就是几秒的事件循环钉死。逐个让出把它摊成一串 <30ms 的小块。
 *
 * 稳态下这个循环一次 spawn 都不发生（全部命中 isRegistered 的纯 SELECT）。
 */
async function registerWorktreeListAsync(
  rawLive: string[],
  db: Database,
): Promise<{ added: number; pruned: number }> {
  const live = normalizeLive(rawLive);
  let added = 0;
  for (const p of live) {
    if (isRegistered(p, db)) continue;
    if (ensureWorkspaceForPath(p, "worktree-scan", db)) added++;
    await yieldToEventLoop();
  }
  return { added, pruned: pruneVanishedWorktrees(live, db) };
}

function normalizeLive(rawLive: string[]): string[] {
  return Array.from(new Set(rawLive.map(canonicalWorkspacePath)));
}

function isRegistered(canonicalPath: string, db: Database): boolean {
  return (
    db.prepare("SELECT 1 FROM workspaces WHERE path = ?").get(canonicalPath) !=
    null
  );
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 反向清理。这张表原来**只进不出** —— 用户在 CLI 里 `git worktree remove`
 * 之后，扫描登记的那行会永久留着，这正是「侧栏显示一堆已不存在的工作区」
 * 的根因（不是漏了清理代码，是压根没有出口）。
 *
 * 两个条件缺一不可：只看「不在 git 的 worktree 列表里」的话，
 * listSiblingWorktrees 一旦失败会返回空数组（git 不可用 / repo 读不到），
 * 那就会把好行全部清空。加上「目录确实不存在」这条，失败场景下一行也不会动。
 * （同理，重扫命中 mtime 短路、复用上一轮缓存的 live 时也是安全的：能删的
 * 只有目录确确实实不在了的行。）
 *
 * 只清 kind='worktree'（不限 created_by —— trellis 自己建的目录被用户在 CLI
 * 里删掉，同样是僵尸）。main / plain 不碰：主 checkout 消失是另一回事，
 * plain 行可能还挂着会话历史。
 * 这里刻意用**未缓存**的 existsSync —— 删除不可逆，不能让一条过期的
 * 「不存在」把还在的目录清掉。
 */
function pruneVanishedWorktrees(live: string[], db: Database): number {
  const liveSet = new Set(live);
  let pruned = 0;
  for (const row of db
    .prepare("SELECT id, path FROM workspaces WHERE kind = 'worktree'")
    .all() as { id: string; path: string }[]) {
    if (
      liveSet.has(canonicalWorkspacePath(row.path)) ||
      fs.existsSync(row.path)
    )
      continue;
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(row.id);
    pruned++;
  }
  return pruned;
}

export function touchWorkspace(
  workspaceId: string,
  db: Database = getDB(),
): void {
  db
    .prepare("UPDATE workspaces SET last_used_at = ? WHERE id = ?")
    .run(Date.now(), workspaceId);
}

/**
 * 侧栏三级的数据源：Project → Workspace（含各自的活跃 session 数）。
 * 排序 = 项目/工作区都按「其下最近活跃的 session」降序，和现有侧栏的
 * `ORDER BY updated_at DESC` 语义一致。
 */
export function listProjectTree(db: Database = getDB(), options: { includeEmpty?: boolean } = {}): ApiProject[] {
  const projects = db
    .prepare("SELECT id, name, cluster_key, git_remote FROM projects")
    .all() as ProjectRow[];
  const workspaces = db
    .prepare(
      `SELECT id, project_id, name, path, kind, git_branch, created_by, last_used_at
       FROM workspaces`,
    )
    .all() as WorkspaceRow[];

  const counts = new Map<string, number>();
  const recency = new Map<string, number>();
  for (const r of db
    .prepare(
      `SELECT workspace_id AS w, COUNT(*) AS n, MAX(updated_at) AS u
       FROM sessions WHERE archived = 0 AND workspace_id IS NOT NULL
         AND ${sessionSourcePredicate()}
       GROUP BY workspace_id`,
    )
    .all() as { w: string; n: number; u: number }[]) {
    counts.set(r.w, r.n);
    recency.set(r.w, r.u);
  }

  const byProject = new Map<string, ApiWorkspace[]>();
  for (const w of workspaces) {
    const list = byProject.get(w.project_id) ?? [];
    list.push({
      id: w.id,
      projectId: w.project_id,
      name: w.name,
      path: w.path,
      kind: w.kind,
      gitBranch: w.git_branch,
      createdBy: w.created_by,
      lastUsedAt: w.last_used_at,
      sessionCount: counts.get(w.id) ?? 0,
    });
    byProject.set(w.project_id, list);
  }

  // 只有 trellis 主动新建的 workspace 首次登记沿用 created_at；discovered 的
  // 活跃度来自 session.updated_at / touchWorkspace，worktree-scan 同样不伪造活跃度。
  const wsRecency = (w: ApiWorkspace) =>
    Math.max(recency.get(w.id) ?? 0, w.lastUsedAt ?? 0);

  // 只留「有活跃 session」或「trellis 自己 worktree add 出来的」workspace，
  // 且**目录还在**。
  // 前者剔掉纯归档目录带来的噪音（实测存量 DB 里混进过 /private/tmp、旧 scratch）；
  // 后者是刚建出来还没开会话的新 worktree —— 恰恰最需要显示，不能被空计数误杀。
  //
  // 路径校验是必须的：worktree-scan 的行以前无条件显示，于是用户在 CLI 里
  // 删掉 worktree 之后，侧栏那行会永久留着、点进去是个已不存在的目录。
  // 行本身不删（会话靠它归组，且「移除 workspace 不连坐会话」是既定纪律），
  // 只是不显示；真正的清理由重扫的 prune 和删除接口负责。
  // 默认保留旧骨架的语义过滤；V2 显式请求现存空目录（包括仅归档目录），
  // 让归档会话保留归属。两种骨架都不显示失效路径，也不按来源区别处理。
  const visible = (w: ApiWorkspace) =>
    (options.includeEmpty || w.sessionCount > 0 || w.createdBy !== "discovered") && pathExists(w.path);

  const out = projects.map((p) => {
    const list = (byProject.get(p.id) ?? [])
      .filter(visible)
      .sort((a, b) => wsRecency(b) - wsRecency(a));
    return {
      id: p.id,
      name: p.name,
      clusterKey: p.cluster_key,
      gitRemote: p.git_remote,
      workspaces: list,
    };
  });

  const projRecency = (p: ApiProject) =>
    p.workspaces.reduce((m, w) => Math.max(m, wsRecency(w)), 0);

  return out
    .filter((p) => p.workspaces.length > 0)
    .sort((a, b) => projRecency(b) - projRecency(a));
}

// ───────────────────────── worktree 重扫 ─────────────────────────
//
// 根因 E。这段以前是 `/api/workspaces/git-status` 的**每请求**同步开销：
// 对 workspaces 表里每条 distinct path 各跑一次 `git worktree list --porcelain`
// 的 spawnSync。BOE devbox 上 48 条路径全指向同一个上百 worktree 的大仓，
// 于是每次侧栏角标请求 = 48 次同步 spawn + 48 遍整仓枚举（N×M），next 主线程
// 被占满，/login 从 5ms 掉到 2–10s；同一个 gitdir 文件在一次请求里被 stat 48 次。
//
// 现在的形状，三道闸：
//   1. **按 repo 去重**：用纯 fs 的 gitCommonDirOf 把 N 条路径折成 M 个 repo，
//      每个 repo 只跑一次 git。48 → 1。
//   2. **mtime 短路**：`<common>/.git/worktrees` 的 mtime 没变 = 没人增删
//      worktree，直接复用上一轮的 live 列表，**一个 git 子进程都不 spawn**。
//   3. **只在后台跑**：定时（默认 60s）+ `fs.watch` 加速；请求路径只读结果。
//      请求路径上不再有任何同步 spawn。

type RepoScanState = { worktreesMtimeMs: number; live: string[] };

/** repo 键（`git:<common dir>` 或 `path:<dir>`）→ 上一轮扫描的结果。 */
const repoScanState = new Map<string, RepoScanState>();

/** 每次**有净变化**的后台扫描 +1。前端据此判断「这份 rescan 结果我看过没」。 */
let rescanGeneration = 0;
let lastRescanResult = { added: 0, pruned: 0 };
let lastRescanAt = 0;
let rescanInFlight: Promise<{ added: number; pruned: number }> | null = null;
/** 已排队的补扫（最多一轮），见 triggerWorktreeRescan。 */
let rescanFollowUp: Promise<{ added: number; pruned: number }> | null = null;
let rescanTimer: ReturnType<typeof setInterval> | null = null;
let watchDebounce: ReturnType<typeof setTimeout> | null = null;
const repoWatchers = new Map<string, fs.FSWatcher>();

/** 一台机器上同时盯的 repo 数上限 —— fs.watch 吃 fd，别为了加速把 fd 耗光。 */
const MAX_REPO_WATCHERS = 32;

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** 后台重扫周期。0 = 不起定时器（单测里手动驱动）。 */
function rescanIntervalMs(): number {
  return envMs("TRELLIS_WORKTREE_RESCAN_MS", 60_000);
}

/** fs.watch 事件的去抖窗口 —— `git worktree add` 会连着触发好几次。 */
function watchDebounceMs(): number {
  return envMs("TRELLIS_WORKTREE_WATCH_MS", 1_000);
}

/**
 * 把「DB 里的 workspace 路径」按 repo 折叠：每个 repo 只留一条代表路径。
 *
 * 归不出 common dir 的（非 git / 已消失）各算一个 repo —— 它们跑 git 也只会
 * 得到空列表，多跑几次的代价可忽略。
 */
function groupPathsByRepo(paths: string[]): Map<string, string> {
  const groups = new Map<string, string>();
  for (const p of paths) {
    const common = gitCommonDirOf(p);
    const key = common
      ? `git:${canonicalWorkspacePath(common)}`
      : `path:${canonicalWorkspacePath(p)}`;
    if (!groups.has(key)) groups.set(key, p);
  }
  return groups;
}

/** repo 键 → 它的 `worktrees` 元数据目录（非 git 键返回 null）。 */
function worktreesDirOf(repoKey: string): string | null {
  return repoKey.startsWith("git:")
    ? path.join(repoKey.slice("git:".length), "worktrees")
    : null;
}

/** 目录不存在（该 repo 还没有任何 linked worktree）算 0，与 stat 失败同值。 */
function worktreesMtimeMs(dir: string | null): number {
  if (!dir) return -1;
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 重扫所有已知 git 工作区的兄弟 worktree：登记新增的 + 清理已消失的。**同步版**。
 *
 * 只留给启动期的 `backfillWorkspaces` —— 那一刻还没有请求要服务，阻塞无所谓，
 * 而且必须同步跑完才能接着刷分支缓存。**任何请求路径都不准调它**，
 * 要重扫走 `rescanWorktreesAsync` / `triggerWorktreeRescan`。
 */
export function rescanWorktrees(db: Database = getDB()): {
  added: number;
  pruned: number;
} {
  let added = 0;
  let pruned = 0;
  for (const [key, p] of groupPathsByRepo(scannablePaths(db))) {
    try {
      // mtime 先于 git 读：扫描期间发生的变动宁可下一轮重扫，也不能被当成已扫过。
      const mtime = worktreesMtimeMs(worktreesDirOf(key));
      const live = listSiblingWorktrees(p);
      repoScanState.set(key, { worktreesMtimeMs: mtime, live });
      const r = registerWorktreeList(live, db);
      added += r.added;
      pruned += r.pruned;
    } catch (e) {
      console.warn(`[trellis] worktree scan skipped ${p}:`, e);
    }
  }
  // 表变了，缓存的存在性判断立刻作废。
  if (added || pruned) invalidatePathExists();
  return { added, pruned };
}

function scannablePaths(db: Database): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT path AS p FROM workspaces WHERE kind IN ('main','worktree')`,
      )
      .all() as { p: string }[]
  ).map((r) => r.p);
}

/**
 * 重扫的异步版 —— 后台定时 / fs.watch 唯一调用的那个。
 *
 * 与同步版的差别只在两点：git 走 execFile 的 promise 版；且命中 mtime 短路时
 * 直接复用上一轮的 live 列表，连 git 都不 spawn（清理仍照跑，只删目录确实
 * 已经不存在的行）。
 */
export async function rescanWorktreesAsync(db: Database = getDB()): Promise<{
  added: number;
  pruned: number;
}> {
  let added = 0;
  let pruned = 0;
  for (const [key, p] of groupPathsByRepo(scannablePaths(db))) {
    try {
      const dir = worktreesDirOf(key);
      const mtime = worktreesMtimeMs(dir);
      const prev = repoScanState.get(key);
      let live: string[];
      if (prev && prev.worktreesMtimeMs === mtime) {
        live = prev.live;
      } else {
        live = await listSiblingWorktreesAsync(p);
        repoScanState.set(key, { worktreesMtimeMs: mtime, live });
      }
      if (dir) watchRepoWorktrees(dir);
      const r = await registerWorktreeListAsync(live, db);
      added += r.added;
      pruned += r.pruned;
    } catch (e) {
      console.warn(`[trellis] worktree scan skipped ${p}:`, e);
    }
  }
  if (added || pruned) invalidatePathExists();
  return { added, pruned };
}

/**
 * `fs.watch` 盯住 `<repo>/.git/worktrees` —— CLI 里 `git worktree add/remove`
 * 一定会动这个目录，这样新 worktree 的可见延迟从「一个定时周期」压到去抖窗口。
 *
 * `persistent: false`：watcher 不该把进程吊着不退（单测里尤其致命）。
 * 平台不支持 / fd 耗尽一律静默降级到定时器 —— 加速是锦上添花。
 */
function watchRepoWorktrees(dir: string): void {
  if (repoWatchers.has(dir) || repoWatchers.size >= MAX_REPO_WATCHERS) return;
  try {
    const w = fs.watch(dir, { persistent: false }, () => {
      scheduleWatchRescan();
    });
    w.on("error", () => {
      try {
        w.close();
      } catch {
        /* 已经关了 */
      }
      repoWatchers.delete(dir);
    });
    repoWatchers.set(dir, w);
  } catch {
    /* 盯不上就算了，定时器兜底 */
  }
}

function scheduleWatchRescan(): void {
  if (watchDebounce) return;
  watchDebounce = setTimeout(() => {
    watchDebounce = null;
    void triggerWorktreeRescan();
  }, watchDebounceMs());
  watchDebounce.unref?.();
}

/**
 * 触发一次后台重扫。
 *
 * 并发折叠 + **一轮补扫**：正在跑的那一轮可能是在这次变化**之前**起的
 * （它早就把 `.git/worktrees` 的 mtime 读过了），直接把新的触发折进去就会
 * 永久漏掉这次变化。所以在跑时最多再排一轮，保证「变化之后一定还会再扫一次」。
 * 排队上限是 1 —— fs.watch 抖动十次也只会多扫一次。
 */
export function triggerWorktreeRescan(
  db: Database = getDB(),
): Promise<{ added: number; pruned: number }> {
  if (!rescanInFlight) {
    rescanInFlight = runRescanOnce(db);
    return rescanInFlight;
  }
  if (rescanFollowUp) return rescanFollowUp;
  rescanFollowUp = rescanInFlight.then(() => {
    rescanFollowUp = null;
    rescanInFlight = runRescanOnce(db);
    return rescanInFlight;
  });
  return rescanFollowUp;
}

async function runRescanOnce(
  db: Database,
): Promise<{ added: number; pruned: number }> {
  try {
    const r = await rescanWorktreesAsync(db);
    lastRescanAt = Date.now();
    // 只有真有净变化才推进 generation —— 前端靠它决定要不要重拉骨架，
    // 每轮都推就等于把「重扫 → 刷新 → 重扫」的自激链接回去了。
    if (r.added || r.pruned) {
      rescanGeneration++;
      lastRescanResult = r;
    }
    return r;
  } catch (e) {
    console.warn("[trellis] worktree rescan failed:", e);
    return { added: 0, pruned: 0 };
  } finally {
    rescanInFlight = null;
  }
}

/** 后台重扫的定时器就位（幂等、纯内存，随便调）。 */
export function ensureWorktreeRescanScheduled(): void {
  if (rescanTimer) return;
  const interval = rescanIntervalMs();
  if (interval <= 0) return;
  rescanTimer = setInterval(() => {
    void triggerWorktreeRescan();
  }, interval);
  rescanTimer.unref?.();
  // 别让第一棵在 CLI 里刚建好的 worktree 等满一个周期才现身。
  void triggerWorktreeRescan();
}

export type WorktreeRescanReport = {
  added: number;
  pruned: number;
  /** 恒为 true：请求路径**不重扫**，只读后台结果。语义保留给前端做兼容判断。 */
  skipped: true;
  /** 有净变化的扫描轮次号；前端只在它变化时才刷新骨架。 */
  generation: number;
  /** 最近一次后台扫描完成的时刻（epoch ms），0 = 还没扫过。 */
  at: number;
};

/**
 * 请求路径读重扫结果的唯一入口：保证后台扫描在跑，然后原样返回上一轮的账。
 * **纯内存 + 一个 setInterval，零 IO、零子进程。**
 */
export function observeWorktreeRescan(): WorktreeRescanReport {
  ensureWorktreeRescanScheduled();
  return {
    added: lastRescanResult.added,
    pruned: lastRescanResult.pruned,
    skipped: true,
    generation: rescanGeneration,
    at: lastRescanAt,
  };
}

/** 单测复位闸：停表、撤 watcher、清扫描缓存。 */
export function stopWorktreeRescan(): void {
  if (rescanTimer) {
    clearInterval(rescanTimer);
    rescanTimer = null;
  }
  if (watchDebounce) {
    clearTimeout(watchDebounce);
    watchDebounce = null;
  }
  for (const w of repoWatchers.values()) {
    try {
      w.close();
    } catch {
      /* 已经关了 */
    }
  }
  repoWatchers.clear();
  repoScanState.clear();
  rescanGeneration = 0;
  lastRescanResult = { added: 0, pruned: 0 };
  lastRescanAt = 0;
}

/**
 * 存量回填：给每个还没归组、但有 workspace_path 的 session 建/找 workspace。
 *
 * 幂等（只看 workspace_id IS NULL），按 distinct path 分组所以 git 子进程调用
 * 次数 = 目录数而非 session 数。**整段吞异常** —— 归组是锦上添花，任何失败都
 * 不该拦住 server 启动。
 */
export function backfillWorkspaces(): {
  paths: number;
  sessions: number;
  worktrees: number;
} {
  const db = getDB();
  let paths = 0;
  let sessions = 0;
  let worktrees = 0;
  try {
    mergeDuplicateWorkspacePaths(db);
    clearScanRegistrationRecency(db);
    const rows = db
      .prepare(
        `SELECT DISTINCT workspace_path AS p FROM sessions
         WHERE workspace_id IS NULL AND workspace_path IS NOT NULL
           AND workspace_path != ''`,
      )
      .all() as { p: string }[];
    for (const { p } of rows) {
      let wsId: string | null = null;
      try {
        wsId = ensureWorkspaceForPath(p, "discovered", db);
      } catch (e) {
        console.warn(`[trellis] workspace backfill skipped ${p}:`, e);
        continue;
      }
      if (!wsId) continue; // 目录已消失 → 留在未归组
      paths++;
      const r = db
        .prepare(
          "UPDATE sessions SET workspace_id = ? WHERE workspace_id IS NULL AND workspace_path = ?",
        )
        .run(wsId, p);
      sessions += Number(r.changes ?? 0);
    }
    worktrees += rescanWorktrees(db).added;
    // 顺带刷一遍分支缓存 —— ensureWorkspaceForPath 的快路径不碰 git，所以
    // 「在某个 worktree 里切了分支」只在这里被看见。启动一次，够 P0 用；
    // 运行期的实时分支由 git 状态接口自己取，不依赖这份缓存。
    for (const w of db
      .prepare(
        `SELECT id, path FROM workspaces WHERE kind IN ('main','worktree')`,
      )
      .all() as { id: string; path: string }[]) {
      const fresh = clusterPath(w.path);
      if (!fresh) continue;
      db.prepare("UPDATE workspaces SET git_branch = ? WHERE id = ?").run(
        fresh.gitBranch,
        w.id,
      );
    }
  } catch (e) {
    console.warn("[trellis] workspace backfill failed:", e);
  }
  return { paths, sessions, worktrees };
}
