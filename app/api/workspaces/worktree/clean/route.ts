import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { getDB } from "@/lib/server/sqlite";
import { invalidatePathExists } from "@/lib/server/workspaces";
import { invalidateGitStatus } from "@/lib/server/git-status";
import { killWorkspaceTerminals } from "@/lib/server/terminals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function git(cwd: string, args: string[]) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, http_proxy: "", https_proxy: "", ALL_PROXY: "" },
  });
}

function streamingCount(workspaceId: string): number {
  try {
    const row = getDB()
      .prepare(
        `SELECT COUNT(*) AS n FROM nodes n JOIN sessions s ON s.id = n.session_id
         WHERE n.status = 'streaming' AND s.workspace_id = ?`,
      )
      .get(workspaceId) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

export type CleanItemPreview = {
  id: string;
  name: string;
  path: string;
  branch: string | null;
  exists: boolean;
  dirtyCount: number;
  ignoredCount: number;
  streaming: number;
  canClean: boolean;
  reason?: string;
};

export async function POST(req: Request) {
  let body: { workspaceIds?: string[]; force?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  const { workspaceIds = [], force = false } = body;
  if (!Array.isArray(workspaceIds) || workspaceIds.length === 0) {
    return Response.json({ error: "workspaceIds 数组必填" }, { status: 400 });
  }

  const db = getDB();
  const placeholders = workspaceIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, name, path, kind, git_branch, created_by
       FROM workspaces
       WHERE id IN (${placeholders})`,
    )
    .all(...workspaceIds) as Array<{
      id: string;
      name: string;
      path: string;
      kind: string;
      git_branch: string | null;
      created_by: string;
    }>;

  if (rows.length === 0) {
    return Response.json({ error: "未找到指定的工作区" }, { status: 404 });
  }

  const previews: CleanItemPreview[] = [];
  for (const ws of rows) {
    if (ws.kind !== "worktree") {
      previews.push({
        id: ws.id,
        name: ws.name,
        path: ws.path,
        branch: ws.git_branch,
        exists: fs.existsSync(ws.path),
        dirtyCount: 0,
        ignoredCount: 0,
        streaming: 0,
        canClean: false,
        reason: "不是 worktree（主 checkout 不可删除）",
      });
      continue;
    }

    const streaming = streamingCount(ws.id);
    const exists = fs.existsSync(ws.path);
    if (!exists) {
      previews.push({
        id: ws.id,
        name: ws.name,
        path: ws.path,
        branch: ws.git_branch,
        exists: false,
        dirtyCount: 0,
        ignoredCount: 0,
        streaming,
        canClean: streaming === 0,
        reason: streaming > 0 ? "有生成中的会话" : "目录已不存在（将清理记录）",
      });
      continue;
    }

    const st = git(ws.path, ["status", "--porcelain", "--ignored=matching"]);
    const lines =
      st.status === 0
        ? st.stdout.split("\n").map((l) => l.trimEnd()).filter(Boolean)
        : [];
    const ignored = lines.filter((l) => l.startsWith("!!"));
    const dirty = lines.filter((l) => !l.startsWith("!!"));

    previews.push({
      id: ws.id,
      name: ws.name,
      path: ws.path,
      branch: ws.git_branch,
      exists: true,
      dirtyCount: dirty.length,
      ignoredCount: ignored.length,
      streaming,
      canClean: streaming === 0,
      reason: streaming > 0 ? "有生成中的会话" : undefined,
    });
  }

  // 阶段一：预览模式（force !== true）
  if (!force) {
    return Response.json({
      preview: true,
      items: previews,
      totalCount: previews.length,
      cleanCount: previews.filter((p) => p.canClean && p.dirtyCount === 0 && p.ignoredCount === 0).length,
      dirtyCount: previews.filter((p) => p.dirtyCount > 0 || p.ignoredCount > 0).length,
    });
  }

  // 阶段二：真删执行模式（force === true）
  let removedCount = 0;
  const errors: Array<{ id: string; name: string; error: string }> = [];
  const parentPaths = new Set<string>();

  for (const item of previews) {
    if (!item.canClean) {
      errors.push({ id: item.id, name: item.name, error: item.reason || "不可清理" });
      continue;
    }

    if (!item.exists) {
      killWorkspaceTerminals(item.id);
      db.prepare("DELETE FROM workspaces WHERE id = ?").run(item.id);
      invalidatePathExists(item.path);
      invalidateGitStatus(item.id);
      removedCount++;
      continue;
    }

    const r = git(item.path, ["worktree", "remove", "--force", item.path]);
    if (r.status !== 0) {
      const errMsg = (r.stderr || r.stdout || r.error?.message || "git worktree remove 失败").trim();
      errors.push({ id: item.id, name: item.name, error: errMsg });
      continue;
    }

    killWorkspaceTerminals(item.id);
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(item.id);
    invalidatePathExists(item.path);
    invalidateGitStatus(item.id);
    removedCount++;
    parentPaths.add(item.path);
  }

  // 对涉及的仓库执行一次 prune 清理元数据
  for (const p of parentPaths) {
    try {
      git(p, ["worktree", "prune"]);
    } catch {
      // 忽略 prune 异常
    }
  }

  return Response.json({
    ok: true,
    removedCount,
    totalRequested: workspaceIds.length,
    errors,
  });
}
