import "server-only";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import type { Database } from "bun:sqlite";

export function activeWorkspaceSessionCount(
  db: Database,
  workspaceId: string,
): number {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions
         WHERE archived = 0 AND workspace_id = ?`,
      )
      .get(workspaceId) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function git(cwd: string, args: string[]) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, http_proxy: "", https_proxy: "", ALL_PROXY: "" },
  });
}

/** 删除前解析主 checkout；worktree 自己删掉后不能再拿它当 prune 的 cwd。 */
export function resolveMainCheckoutPath(
  db: Database,
  projectId: string,
  currentPath: string,
): string | null {
  const main = db
    .prepare(
      `SELECT path FROM workspaces
       WHERE project_id = ? AND kind = 'main'
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(projectId) as { path: string } | undefined;
  if (main && fs.existsSync(main.path)) return main.path;

  const listed = git(currentPath, ["worktree", "list", "--porcelain"]);
  if (listed.status !== 0) return null;
  const first = listed.stdout
    .split("\n")
    .find((line) => line.startsWith("worktree "))
    ?.slice("worktree ".length)
    .trim();
  return first && fs.existsSync(first) ? first : null;
}

export function pruneWorktreeMetadata(mainCheckoutPath: string): void {
  git(mainCheckoutPath, ["worktree", "prune"]);
}
