import { startTaskRun } from "@/lib/server/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 手动触发。跑起来立刻返回 —— run 与 HTTP 解耦（同会话 run 的既有契约），
// 前端拿 runId 后走轮询 / SSE 看进度。
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = startTaskRun({ taskId: id, triggerKind: "manual" });
  if (!r.ok) {
    // 「排队中」和「上一次还在跑」都不是错误，是状态 —— 用 202 而不是 4xx，
    // 前端照常刷新列表就能看到那条 pending/skipped 留档。
    const queued = r.reason.startsWith("queued") || r.reason.includes("still active");
    return Response.json({ error: r.reason, runId: r.runId }, { status: queued ? 202 : 400 });
  }
  return Response.json(r);
}
