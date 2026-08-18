import { getNode } from "@/lib/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 按需拉取单个节点的完整 toolCalls 数组。GET /api/sessions/[id] 为了压载荷
// 不再下发它（改发预计算 toolCallStats），展开动线面板时才走这个端点。
// 流式节点用不到——toolCalls 随流事件直接进客户端 store。
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const node = getNode(id);
  if (!node) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ toolCalls: node.toolCalls });
}
