import "server-only";
import fs from "node:fs";
import type { Database } from "bun:sqlite";
import { getDB } from "./sqlite";
import { uuid } from "@/lib/uuid";
import { clusterPath, listSiblingWorktrees } from "./project-cluster";

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
  // 快路径：已登记过的目录直接返回，**一个 git 子进程都不 spawn**。
  // 这条路径必须便宜 —— cli-sync-watcher 每次 jsonl 变动都会走到这里
  // （流式期间每秒多次），在那里 spawn git 是不可接受的。
  // 代价：git_branch 只在首次登记与启动扫描时刷新。P0 不显示分支，
  // P2 加 git 状态角标时会带自己的轮询刷新。
  const existing = db
    .prepare("SELECT id, created_by FROM workspaces WHERE path = ?")
    .get(absPath) as { id: string; created_by: string } | undefined;
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

  const cluster = clusterPath(absPath);
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
    absPath,
    cluster.kind,
    cluster.gitBranch,
    createdBy,
    now,
    now,
  );
  // 冲突时上面那个 uuid 没被写进去，必须回查真正落库的 id。
  const row = db
    .prepare("SELECT id FROM workspaces WHERE path = ?")
    .get(absPath) as { id: string } | undefined;
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
  const live = listSiblingWorktrees(absPath);
  let added = 0;
  for (const p of live) {
    const existed = db
      .prepare("SELECT 1 FROM workspaces WHERE path = ?")
      .get(p);
    if (existed) continue;
    if (ensureWorkspaceForPath(p, "worktree-scan", db)) added++;
  }

  // 反向清理。这张表原来**只进不出** —— 用户在 CLI 里 `git worktree remove`
  // 之后，扫描登记的那行会永久留着，这正是「侧栏显示一堆已不存在的工作区」
  // 的根因（不是漏了清理代码，是压根没有出口）。
  //
  // 两个条件缺一不可：只看「不在 git 的 worktree 列表里」的话，
  // listSiblingWorktrees 一旦失败会返回空数组（git 不可用 / repo 读不到），
  // 那就会把好行全部清空。加上「目录确实不存在」这条，失败场景下一行也不会动。
  //
  // 只清 kind='worktree'（不限 created_by —— trellis 自己建的目录被用户在 CLI
  // 里删掉，同样是僵尸）。main / plain 不碰：主 checkout 消失是另一回事，
  // plain 行可能还挂着会话历史。
  // 这里刻意用**未缓存**的 existsSync —— 删除不可逆，不能让一条过期的
  // 「不存在」把还在的目录清掉。
  const liveSet = new Set(live);
  let pruned = 0;
  for (const row of db
    .prepare("SELECT id, path FROM workspaces WHERE kind = 'worktree'")
    .all() as { id: string; path: string }[]) {
    if (liveSet.has(row.path) || fs.existsSync(row.path)) continue;
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(row.id);
    pruned++;
  }
  return { added, pruned };
}

export function touchWorkspace(workspaceId: string): void {
  getDB()
    .prepare("UPDATE workspaces SET last_used_at = ? WHERE id = ?")
    .run(Date.now(), workspaceId);
}

/**
 * 侧栏三级的数据源：Project → Workspace（含各自的活跃 session 数）。
 * 排序 = 项目/工作区都按「其下最近活跃的 session」降序，和现有侧栏的
 * `ORDER BY updated_at DESC` 语义一致。
 */
export function listProjectTree(): ApiProject[] {
  const db = getDB();
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
         AND kind = 'user'
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
  const visible = (w: ApiWorkspace) =>
    (w.sessionCount > 0 || w.createdBy !== "discovered") && pathExists(w.path);

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

/**
 * 重扫所有已知 git 工作区的兄弟 worktree：登记新增的 + 清理已消失的。
 *
 * 从 backfillWorkspaces 里提出来，是因为它现在有第二个调用方（git 状态接口）。
 * boot-only 的时代，在 CLI 里 `git worktree add` 出来的目录要等 trellis 重启
 * 才会现身 —— 而「在 CLI 里开 worktree、在 trellis 里干活」恰恰是这个功能
 * 要承接的工作流，等重启等于不可用。
 *
 * **不要挂到 `/api/sessions` 上**：那条路径在流式期间是 ~1.6 次/秒
 * （侧栏 fetch 依赖 sessionsRevision ← cli-sync 的 600ms 合并窗口），
 * 在那里为每个 repo spawn `git worktree list` 会把 SSE 拖垮。
 */
export function rescanWorktrees(db: Database = getDB()): {
  added: number;
  pruned: number;
} {
  let added = 0;
  let pruned = 0;
  for (const { p } of db
    .prepare(
      `SELECT DISTINCT path AS p FROM workspaces WHERE kind IN ('main','worktree')`,
    )
    .all() as { p: string }[]) {
    try {
      const r = registerSiblingWorktrees(p, db);
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
