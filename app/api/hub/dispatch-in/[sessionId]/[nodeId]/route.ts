import "server-only";
import { DISPATCH_FROM_HEADER, MACHINE_NAME_RE } from "@/lib/hub-dispatch";
import { dispatchedTurnStatus } from "@/lib/server/hub-dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/hub/dispatch-in/<sessionId>/<nodeId>  ← hub 中继
// 来源机器取它派来的那一轮：状态（running / waiting / done / error）与回答。
// 只认 hub_dispatches 里记着「由这台来源派来」的那一轮，其余一律 404 —— 这个口子
// 不能变成读本机任意会话的旁路。
export async function GET(
  req: Request,
  ctx: { params: Promise<{ sessionId: string; nodeId: string }> },
) {
  const from = req.headers.get(DISPATCH_FROM_HEADER)?.trim() || "";
  if (!MACHINE_NAME_RE.test(from)) {
    return Response.json({ error: "缺来源机器（只接受 hub 中继的调用）" }, { status: 400 });
  }
  const { sessionId, nodeId } = await ctx.params;
  const s = dispatchedTurnStatus(from, sessionId, nodeId);
  if (!s) return Response.json({ error: `没有 ${from} 派来的这一轮` }, { status: 404 });
  return Response.json(s, { headers: { "cache-control": "no-store" } });
}
