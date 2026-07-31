import { getRun } from "@/lib/server/tasks";
import { abortRun } from "@/lib/server/run-bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 中止一次任务执行。走的是会话 run 完全相同的 abort 路径 —— finally 会把节点
// 收成 error/'aborted'，onSettled 照常触发把 task_run 收尾。
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = getRun(id);
  if (!run) return Response.json({ error: "not found" }, { status: 404 });
  if (!run.nodeId) return Response.json({ error: "run 尚未 spawn" }, { status: 409 });
  abortRun(run.nodeId);
  return Response.json({ ok: true });
}
