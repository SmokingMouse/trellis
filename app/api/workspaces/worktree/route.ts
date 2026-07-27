import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { getDB } from "@/lib/server/sqlite";
import { ensureWorkspaceForPath } from "@/lib/server/workspaces";
import { killWorkspaceTerminals } from "@/lib/server/terminals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// S1 P2：在项目下直接开 / 收 worktree。
//
// POST   { projectId, branch, ref? } → git worktree add <同级目录>/<branch> -b <branch> [ref]
// DELETE ?workspaceId=…&force=0|1   → git worktree remove（未提交改动默认拒删）
//
// 落盘位置刻意是**同级兄弟目录**（`<主 checkout 的父目录>/<branch>`）：
// 用户现有的 sole/trevally 就这么放，`git worktree add` 的习惯也是；
// 集中到 ~/.trellis/worktrees/ 会让人在 CLI 里 cd 不方便，而 CLI 仍然要用。

function git(cwd: string, args: string[]) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, http_proxy: "", https_proxy: "", ALL_PROXY: "" },
  });
}

/** 分支名不能带路径穿越/空白 —— 它会直接变成磁盘上的目录名。 */
function badBranch(b: string): string | null {
  if (!b || b.length > 100) return "分支名为空或过长";
  if (/[\s~^:?*[\\]/.test(b)) return "分支名含 git 不允许的字符";
  if (b.includes("..") || b.startsWith("/") || b.startsWith("-"))
    return "分支名不合法";
  return null;
}

export async function POST(req: Request) {
  let body: { projectId?: string; branch?: string; ref?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const { projectId, branch, ref } = body;
  if (!projectId || !branch) {
    return Response.json({ error: "projectId 与 branch 必填" }, { status: 400 });
  }
  const bad = badBranch(branch);
  if (bad) return Response.json({ error: bad }, { status: 400 });

  const db = getDB();
  // 从这个项目里挑一个 git 工作区当 `git worktree add` 的执行点。优先主
  // checkout —— 它一定在，且它的父目录就是我们要落盘的地方。
  const base = db
    .prepare(
      `SELECT path FROM workspaces WHERE project_id = ? AND kind IN ('main','worktree')
       ORDER BY CASE kind WHEN 'main' THEN 0 ELSE 1 END LIMIT 1`,
    )
    .get(projectId) as { path: string } | undefined;
  if (!base) {
    return Response.json(
      { error: "这个项目下没有 git 工作区，无法新建 worktree" },
      { status: 400 },
    );
  }

  const target = path.join(path.dirname(base.path), branch);
  if (fs.existsSync(target)) {
    return Response.json({ error: `目录已存在：${target}` }, { status: 409 });
  }

  // 已有同名分支就直接 checkout 它，否则用 -b 新建。两种都要能用 ——
  // 「把已有分支拉出来并行开发」和「开一条新分支」一样常见。
  const exists =
    git(base.path, ["rev-parse", "--verify", `refs/heads/${branch}`]).status === 0;
  const args = exists
    ? ["worktree", "add", target, branch]
    : ["worktree", "add", target, "-b", branch, ...(ref ? [ref] : [])];

  const r = git(base.path, args);
  if (r.status !== 0) {
    return Response.json(
      { error: (r.stderr || r.stdout || "git worktree add 失败").trim() },
      { status: 500 },
    );
  }

  // created_by='trellis' —— 只有这一类才允许从 UI 删磁盘。
  const id = ensureWorkspaceForPath(target, "trellis", db);
  return Response.json({ ok: true, workspaceId: id, path: target });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const force = url.searchParams.get("force") === "1";
  if (!workspaceId) {
    return Response.json({ error: "workspaceId required" }, { status: 400 });
  }
  const db = getDB();
  const ws = db
    .prepare("SELECT path, kind, created_by FROM workspaces WHERE id = ?")
    .get(workspaceId) as
    | { path: string; kind: string; created_by: string }
    | undefined;
  if (!ws) return Response.json({ error: "workspace not found" }, { status: 404 });
  if (ws.kind !== "worktree") {
    return Response.json(
      { error: "只能删 worktree —— 主 checkout 和普通目录不归 trellis 管" },
      { status: 400 },
    );
  }

  // 未提交改动拒删（除非显式 force）。丢掉别人几小时的活是不可逆的，
  // 这道闸比「少点一次确认」值钱得多。
  if (!force) {
    const dirty = git(ws.path, ["status", "--porcelain"]);
    if (dirty.status === 0 && dirty.stdout.trim()) {
      return Response.json(
        {
          error: "有未提交的改动",
          dirty: dirty.stdout.trim().split("\n").slice(0, 20),
        },
        { status: 409 },
      );
    }
  }

  // 先收终端再删目录：tmux 是终端列表的真源，留下指向已消失目录的 session
  // 就会一直脏下去（这是 P1 留的那个悬空调用点）。
  killWorkspaceTerminals(workspaceId);

  const r = git(ws.path, [
    "worktree",
    "remove",
    ...(force ? ["--force"] : []),
    ws.path,
  ]);
  if (r.status !== 0) {
    return Response.json(
      { error: (r.stderr || r.stdout || "git worktree remove 失败").trim() },
      { status: 500 },
    );
  }
  // 会话不连坐删：workspace_id 是 ON DELETE SET NULL，那些 session 仍持有
  // workspace_path、仍能 resume，只是回到未归组。
  db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
  return Response.json({ ok: true });
}
