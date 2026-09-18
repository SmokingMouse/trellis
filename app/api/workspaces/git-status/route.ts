import { getDB } from "@/lib/server/sqlite";
import { collectGitStatus } from "@/lib/server/git-status";
import { observeWorktreeRescan } from "@/lib/server/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/workspaces/git-status
//   → { statuses: [{ id, branch, dirty, reclaimable }],
//       rescan: { added, pruned, skipped, generation, at } }
//
// 侧栏拿到骨架（随 /api/sessions 下发）之后异步拉这一路，渐进填角标。
// 分成两个请求是刻意的：/api/sessions 在流式期间是 ~1.6 次/秒的热循环，
// 把 spawn git 塞进去会拖垮 SSE；而角标晚 100ms 出现没人在意。
//
// 认证不用自己做 —— proxy.ts 的 matcher 盖住了 /api/*。
export async function GET() {
  // 根因 E：这里**不再重扫** worktree。
  //
  // 曾经每次 GET 都无条件 `rescanWorktrees()` —— 对 DB 里每条 distinct path
  // 各跑一次 `git worktree list` 的 spawnSync。BOE devbox 上 48 条路径全指向
  // 同一个上百 worktree 的大仓，于是一次角标请求 = 48 次同步 spawn + 48 遍
  // 整仓枚举，next 主线程被占满，/login 从 5ms 掉到 2–10s。
  //
  // 重扫改由后台节流跑（定时 + fs.watch，见 lib/server/workspaces.ts）。
  // 这里只读它的账：纯内存，零 IO、零子进程。`skipped: true` 明说
  // 「本次没扫」—— 角标是渐进增强，没扫不是错误，不要因此报错。
  const rescan = observeWorktreeRescan();

  const rows = getDB()
    .prepare(
      `SELECT id, path, kind FROM workspaces WHERE kind IN ('main','worktree')`,
    )
    .all() as { id: string; path: string; kind: string }[];

  return Response.json({ statuses: await collectGitStatus(rows), rescan });
}
