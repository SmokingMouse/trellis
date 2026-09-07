import "server-only";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";

export function activeWorkspaceSessionCount(
  db: Database,
  workspaceId: string,
): number {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions
         WHERE archived = 0 AND kind = 'user' AND workspace_id = ?`,
      )
      .get(workspaceId) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

export function isDefaultCleanCandidate(item: {
  canClean: boolean;
  dirtyCount: number;
  ignoredCount: number;
  sessionCount: number;
}): boolean {
  return (
    item.canClean &&
    item.dirtyCount === 0 &&
    item.ignoredCount === 0 &&
    item.sessionCount === 0
  );
}

function git(cwd: string, args: string[]) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, http_proxy: "", https_proxy: "", ALL_PROXY: "" },
  });
}

/** 删除前解析所属 clone 的主 checkout；worktree 自己删掉后就取不到 common-dir。 */
export function resolveMainCheckoutPath(
  db: Database,
  projectId: string,
  currentPath: string,
): string | null {
  // project 按 remote 聚类，同一 project 可能有多个 clone。必须先问目标 worktree
  // 自己的 common-dir；否则 DB 里较早的另一个 clone 会吃掉 prune，当前 clone 的
  // stale metadata 则原地残留。
  const common = git(currentPath, ["rev-parse", "--git-common-dir"]);
  if (common.status === 0 && common.stdout.trim()) {
    const commonDir = path.resolve(currentPath, common.stdout.trim());
    const checkout = path.dirname(commonDir);
    if (fs.existsSync(checkout)) return checkout;
  }

  // 目录已先被外部删除时无法再问 git，只能用同 project 的 main 行兜底。
  const main = db
    .prepare(
      `SELECT path FROM workspaces
       WHERE project_id = ? AND kind = 'main'
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(projectId) as { path: string } | undefined;
  if (main && fs.existsSync(main.path)) return main.path;
  return null;
}

export function pruneWorktreeMetadata(mainCheckoutPath: string): void {
  git(mainCheckoutPath, ["worktree", "prune"]);
}
