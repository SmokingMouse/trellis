import { listProjectTree } from "@/lib/server/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// S89: project/workspace 三级树的独立入口。
//
// 为什么新开一路而不复用现成的两个：
// ① `/api/workspaces/recent` 只回 { path, shortName, lastUsedAt, source } —— **没有 id、
//    没有 kind、没有 createdBy**，而管理台要做的「能不能删这个 worktree」判据恰好是
//    `createdBy === 'trellis' && kind === 'worktree'`，删除接口也只认 workspaceId。
// ② 这棵树今天挂在 `/api/sessions` 上（侧栏一次拿齐），但那条在流式期间是 ~1.6 次/秒
//    的热路径且带着整个会话列表 —— 管理台为了几行工作区去拉它，既浪费又会把自己的
//    刷新和会话流式耦在一起。
//
// 只读、无副作用。git 的实时状态（branch/dirty/reclaimable）在 `/api/workspaces/git-status`
// ——那条**带副作用**（每次调用 rescan + prune），所以刻意不并进来。
export async function GET() {
  return Response.json({ projects: listProjectTree() });
}
