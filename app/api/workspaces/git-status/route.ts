import { getDB } from "@/lib/server/sqlite";
import { collectGitStatus } from "@/lib/server/git-status";
import { rescanWorktrees } from "@/lib/server/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/workspaces/git-status
//   → { statuses: [{ id, branch, dirty, reclaimable }], rescan: {added, pruned} }
//
// 侧栏拿到骨架（随 /api/sessions 下发）之后异步拉这一路，渐进填角标。
// 分成两个请求是刻意的：/api/sessions 在流式期间是 ~1.6 次/秒的热循环，
// 把 spawn git 塞进去会拖垮 SSE；而角标晚 100ms 出现没人在意。
//
// 认证不用自己做 —— proxy.ts 的 matcher 盖住了 /api/*。
export async function GET() {
  // 顺带重扫一遍兄弟 worktree。这是「在 CLI 里 git worktree add 出来的目录」
  // 出现在侧栏的唯一及时通道 —— 原来只在 boot 扫一次，意味着要重启 trellis
  // 才看得见，而「CLI 里开 worktree、trellis 里干活」正是要承接的工作流。
  // 同一趟把已消失的行也清掉（那张表以前只进不出）。
  let rescan = { added: 0, pruned: 0 };
  try {
    rescan = rescanWorktrees();
  } catch {
    // 扫描失败不该让状态查询一起挂 —— 各自独立。
  }

  const rows = getDB()
    .prepare(
      `SELECT id, path, kind FROM workspaces WHERE kind IN ('main','worktree')`,
    )
    .all() as { id: string; path: string; kind: string }[];

  return Response.json({ statuses: await collectGitStatus(rows), rescan });
}
