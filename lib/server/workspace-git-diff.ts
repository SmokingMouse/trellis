import "server-only";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getDB } from "@/lib/server/sqlite";

// 工作区 diff 审阅的服务端能力（/api/workspaces/git-diff 及其 /file 子路由共用）。
//
// 用异步 execFile 而不是 spawnSync：大仓库上 git diff 能跑几百毫秒，同步 spawn
// 会把 next 主线程整个卡住（见 git-status 路由里的根因 E 记录）。

export type DiffScope = "all" | "unstaged" | "staged" | "base";
export const DIFF_SCOPES: DiffScope[] = ["all", "unstaged", "staged", "base"];

export type GitResult = { code: number; stdout: string; stderr: string };

const MAX_BUFFER = 20 * 1024 * 1024;

export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      // quotepath=false：中文路径原样输出；固定 a/ b/ 前缀，不受用户 diff.noprefix 影响
      ["-c", "core.quotepath=false", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", ...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
        timeout: 30_000,
        env: { ...process.env, http_proxy: "", https_proxy: "", ALL_PROXY: "", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

export type DiffTarget = { workspaceId: string | null; name: string; path: string; sessionId: string | null };

/** workspaceId 或 sessionId（取会话的 workspace_path）定位目录。路径只来自 DB，不接受客户端直传。 */
export function resolveDiffTarget(params: URLSearchParams): { target: DiffTarget } | { error: string; status: number } {
  const workspaceId = params.get("workspaceId");
  const sessionId = params.get("sessionId");
  const db = getDB();
  let target: DiffTarget | null = null;
  if (workspaceId) {
    const ws = db.prepare("SELECT id, name, path FROM workspaces WHERE id = ?").get(workspaceId) as
      | { id: string; name: string; path: string }
      | undefined;
    if (!ws) return { error: "工作区未找到", status: 404 };
    target = { workspaceId: ws.id, name: ws.name, path: ws.path, sessionId };
  } else if (sessionId) {
    const s = db
      .prepare(
        "SELECT s.workspace_path AS path, s.workspace_id AS wid, w.name AS wname FROM sessions s LEFT JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?",
      )
      .get(sessionId) as { path: string | null; wid: string | null; wname: string | null } | undefined;
    if (!s) return { error: "会话未找到", status: 404 };
    if (!s.path) return { error: "这个会话没有绑定工作区", status: 400 };
    target = { workspaceId: s.wid, name: s.wname || path.basename(s.path), path: s.path, sessionId };
  } else {
    return { error: "workspaceId 或 sessionId 必填", status: 400 };
  }
  if (!fs.existsSync(target.path)) return { error: `目录不存在：${target.path}`, status: 404 };
  return { target };
}

/** 默认分支：origin/HEAD 指向的分支，否则依次试 main / master（本地优先于远端）。 */
export async function resolveBaseRef(cwd: string): Promise<string | null> {
  const head = await git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();
  for (const ref of ["main", "master", "origin/main", "origin/master"]) {
    const r = await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (r.code === 0) return ref;
  }
  return null;
}

/**
 * 仓库内相对路径 → 绝对路径，并确认它（解析符号链接后）仍在仓库根内。
 * 拒绝绝对路径、`..` 越界、NUL 字节。
 */
export function fenceRepoPath(root: string, rel: string): string | null {
  if (!rel || rel.includes("\0") || path.isAbsolute(rel)) return null;
  const abs = path.resolve(root, rel);
  const rootReal = fs.realpathSync(root);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    const real = fs.realpathSync(abs);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null;
  } catch {
    // 文件不存在（已删除）：只按词法检查，调用方会改走 git show
  }
  return abs;
}
