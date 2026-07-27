import "server-only";
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
    .prepare("SELECT id FROM workspaces WHERE path = ?")
    .get(absPath) as { id: string } | undefined;
  if (existing) return existing.id;

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

  const id = uuid();
  db.prepare(
    `INSERT INTO workspaces
       (id, project_id, name, path, kind, git_branch, created_by, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    project.id,
    cluster.workspaceName,
    absPath,
    cluster.kind,
    cluster.gitBranch,
    createdBy,
    now,
    now,
  );
  return id;
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
): number {
  let n = 0;
  for (const p of listSiblingWorktrees(absPath)) {
    const existed = db
      .prepare("SELECT 1 FROM workspaces WHERE path = ?")
      .get(p);
    if (existed) continue;
    if (ensureWorkspaceForPath(p, "worktree-scan", db)) n++;
  }
  return n;
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

  // 只留「有活跃 session」或「trellis 自己 worktree add 出来的」workspace。
  // 前者剔掉纯归档目录带来的噪音（实测存量 DB 里混进过 /private/tmp、旧 scratch）；
  // 后者是刚建出来还没开会话的新 worktree —— 恰恰最需要显示，不能被空计数误杀。
  const visible = (w: ApiWorkspace) =>
    w.sessionCount > 0 || w.createdBy !== "discovered";

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
    // 每次启动都重扫一遍（不止回填时）—— 用户在 CLI 里 `git worktree add` 出来的
    // 新分支目录，重启后该自动出现在侧栏，而不是等到在里面开了会话才现身。
    for (const { p } of db
      .prepare(
        `SELECT DISTINCT path AS p FROM workspaces WHERE kind IN ('main','worktree')`,
      )
      .all() as { p: string }[]) {
      try {
        worktrees += registerSiblingWorktrees(p, db);
      } catch (e) {
        console.warn(`[trellis] worktree scan skipped ${p}:`, e);
      }
    }
    // 顺带刷一遍分支缓存 —— ensureWorkspaceForPath 的快路径不碰 git，所以
    // 「在某个 worktree 里切了分支」只在这里被看见。启动一次，够 P0 用；
    // P2 上 git 状态角标时会带自己的轮询。
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
