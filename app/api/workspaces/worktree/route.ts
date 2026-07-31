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
// GET                                → 可作为起点的 checkout 列表（谁能开 worktree）
// POST   { projectId, branch, ref? } → git worktree add <同级目录>/<branch> -b <branch> [ref]
// DELETE ?workspaceId=…              → **只预演**，回传将被删掉的东西
// DELETE ?workspaceId=…&force=1      → 真删（git worktree remove）
//
// 删磁盘只对 `created_by='trellis'` 的行开放（UI 侧的门槛），用户自己在 CLI 里
// 建的 worktree 该在 CLI 里删。至于「列表里留着已不存在的行」，那由重扫的
// 自动 prune 解决（lib/server/workspaces.ts 的 registerSiblingWorktrees），
// 不需要一个手动的「移除」动作 —— 实测过：手动摘掉一个目录仍在的行，
// 下一次重扫就把它加回来了，那种按钮点了等于没点。
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

/**
 * 取一条**非空**的 git 错误信息。
 *
 * `spawnSync` 在 cwd 不存在时既不给 status 也不给 stderr（实测
 * `{error: "ENOENT ... posix_spawn 'git'", status: undefined, stderr: null}`），
 * 只看 stderr/stdout 会得到空串 —— 界面上就是「失败了但不说为什么」。
 */
function gitError(
  r: ReturnType<typeof git>,
  fallback: string,
): string {
  return (r.stderr || r.stdout || r.error?.message || fallback).trim();
}

/** 这个 workspace 下有没有正在生成的会话 —— 删掉它的目录会把 run 打断。 */
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

/** 分支名不能带路径穿越/空白 —— 它会直接变成磁盘上的目录名。 */
function badBranch(b: string): string | null {
  if (!b || b.length > 100) return "分支名为空或过长";
  if (/[\s~^:?*[\\]/.test(b)) return "分支名含 git 不允许的字符";
  if (b.includes("..") || b.startsWith("/") || b.startsWith("-"))
    return "分支名不合法";
  return null;
}

/** 一个项目里能当 `git worktree add` 执行点的 checkout。 */
export type WorktreeBase = {
  projectId: string;
  projectName: string;
  /** 执行点（主 checkout 优先） */
  path: string;
  /** 新 worktree 的落点父目录 —— 前端拿它做「会建在哪」的实时预览 */
  parent: string;
  branch: string | null;
};

/**
 * 从一个项目里挑执行点。优先主 checkout —— 它一定在，且它的父目录就是我们
 * 要落盘的地方。
 *
 * 必须逐个验存活：workspace 行会指向已被删掉的目录（我们刻意保留行，让会话
 * 历史不连坐），拿这种路径当 cwd 会让 spawnSync 直接 ENOENT，而那条错误路径
 * 上 stderr 是 null、报出来是一句空话。
 *
 * GET 和 POST 共用同一个函数，是为了让「下拉里列出来的项目」与「POST 真能建
 * 成的项目」永远是同一批 —— 两处各写一遍 SQL 迟早会漂移成「列表里有、点了报
 * 没有 git 工作区」。
 */
function pickBase(
  projectId: string,
  db: ReturnType<typeof getDB>,
): WorktreeBase | null {
  const rows = db
    .prepare(
      `SELECT w.path AS path, w.git_branch AS branch, p.name AS projectName
         FROM workspaces w JOIN projects p ON p.id = w.project_id
        WHERE w.project_id = ? AND w.kind IN ('main','worktree')
        ORDER BY CASE w.kind WHEN 'main' THEN 0 ELSE 1 END`,
    )
    .all(projectId) as { path: string; branch: string | null; projectName: string }[];
  const hit = rows.find((c) => fs.existsSync(c.path));
  if (!hit) return null;
  return {
    projectId,
    projectName: hit.projectName,
    path: hit.path,
    parent: path.dirname(hit.path),
    branch: hit.branch,
  };
}

/**
 * 哪些项目能开 worktree —— WorkspacePicker 的「从哪个 repo 起」下拉数据源。
 *
 * 刻意不复用 listProjectTree()：那份为侧栏做了「只留有会话或非 discovered 的
 * workspace」的可见性过滤，一个 discovered 且零会话的主 checkout 会被它藏掉，
 * 于是项目在下拉里消失、而 POST 明明建得成。这里要的是「能不能建」，不是
 * 「该不该显示」。
 */
function listBases(db: ReturnType<typeof getDB>): WorktreeBase[] {
  const projects = db
    .prepare(
      `SELECT DISTINCT w.project_id AS id,
              MAX(COALESCE(w.last_used_at, 0)) AS recency
         FROM workspaces w
        WHERE w.kind IN ('main','worktree')
        GROUP BY w.project_id
        ORDER BY recency DESC`,
    )
    .all() as { id: string; recency: number }[];
  return projects
    .map((p) => pickBase(p.id, db))
    .filter((b): b is WorktreeBase => b !== null);
}

export async function GET() {
  return Response.json({ bases: listBases(getDB()) });
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
  const base = pickBase(projectId, db);
  if (!base) {
    return Response.json(
      { error: "这个项目下没有 git 工作区，无法新建 worktree" },
      { status: 400 },
    );
  }

  const target = path.join(base.parent, branch);
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
      { error: gitError(r, "git worktree add 失败") },
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

  // 会话不连坐删：workspace_id 是 ON DELETE SET NULL，那些 session 仍持有
  // workspace_path、仍能 resume，只是回到未归组。
  const dropRow = () =>
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);

  // ① 目录已经不在了 —— 没有 git 可跑，直接摘行。
  //
  // 这条以前是死路：spawnSync 在不存在的 cwd 下 status 是 undefined，于是
  // `dirty.status === 0` 为假 → 脏改动闸被**静默跳过**，接着终端已经被杀，
  // 最后 `r.status !== 0` 成立返回 500，而 DELETE FROM 永不执行。
  // 净效果：僵尸行永远删不掉，且每点一次白杀一次终端。
  //
  // 终端要收 —— tmux 是终端列表的真源，摘掉行却留着 session，就会在 tmux 里
  // 堆一地再也无人认领的孤儿。
  if (!fs.existsSync(ws.path)) {
    killWorkspaceTerminals(workspaceId);
    dropRow();
    return Response.json({ ok: true, gone: true });
  }

  // ② 真删磁盘。只对 worktree，且要过三道闸。
  if (ws.kind !== "worktree") {
    return Response.json(
      { error: "只能删 worktree —— 主 checkout 和普通目录不归 trellis 管" },
      { status: 400 },
    );
  }

  const running = streamingCount(workspaceId);
  if (running > 0) {
    return Response.json(
      { error: `这个工作区下还有 ${running} 个会话正在生成，停下来再删` },
      { status: 409 },
    );
  }

  if (!force) {
    // force=0 一律**只预演、绝不执行**。删目录不可逆，而这个按钮在触屏上是
    // 常显的（见 SessionSidebar 的 pointer-coarse 分支），误触代价太大 ——
    // 「干净就直接删」实测下来就是点一下目录就没了，连问都不问。
    //
    // `--ignored=matching` 一次拿全两类：会拦人的（改动 / 未跟踪）和会被
    // **静默**删掉的（被 .gitignore 忽略的）。后者才是真正的数据风险 ——
    // `git worktree remove` 不把 ignored 文件当障碍，连目录一起删；而本仓库
    // .gitignore 里就有 `.env*`（凭证，S79 丢过一次导致认证闸静默关闭）
    // 和 `/.claude/`（本地 settings）。git status 默认根本不列它们。
    const st = git(ws.path, ["status", "--porcelain", "--ignored=matching"]);
    const lines =
      st.status === 0
        ? st.stdout.split("\n").map((l) => l.trimEnd()).filter(Boolean)
        : [];
    const ignored = lines.filter((l) => l.startsWith("!!"));
    const dirty = lines.filter((l) => !l.startsWith("!!"));
    return Response.json(
      {
        preview: true,
        path: ws.path,
        dirty: dirty.slice(0, 20),
        dirtyCount: dirty.length,
        ignored: ignored.map((l) => l.slice(3)).slice(0, 20),
        ignoredCount: ignored.length,
      },
      { status: 409 },
    );
  }

  // 删成功了再收终端。反过来（原实现的顺序）会在 git 失败时把终端白白杀掉，
  // 而那次操作明明什么也没删成。
  const r = git(ws.path, [
    "worktree",
    "remove",
    ...(force ? ["--force"] : []),
    ws.path,
  ]);
  if (r.status !== 0) {
    return Response.json(
      { error: gitError(r, "git worktree remove 失败") },
      { status: 500 },
    );
  }
  killWorkspaceTerminals(workspaceId);
  dropRow();
  return Response.json({ ok: true });
}
