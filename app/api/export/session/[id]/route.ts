// 会话接力 · 导出：GET /api/export/session/<id>[?nodeId=<叶节点>]
// 返回 lib/session-relay.ts 的 RelayFile。挂在 /api/export/ 下 = 受网关外流闸
// （shareOut=false 的机器经 hub 访问一律 403，见 tenancy/gateway/node-targets.ts）。
import { exportRelaySession, RelayError } from "@/lib/server/session-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const nodeId = new URL(req.url).searchParams.get("nodeId");
  try {
    const file = exportRelaySession(id, nodeId);
    return Response.json(file, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof RelayError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[trellis/relay] 导出失败：", err);
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
