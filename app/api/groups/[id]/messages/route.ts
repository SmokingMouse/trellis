import { groupErrorResponse, readGroupJson, sendGroupMessage } from "@/lib/server/groups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 在群里发一条消息：{ text, provider? } → { node, round }。这一轮跑在服务端，
 * 进度与各位的发言走 GET /api/groups/[id]/events + 各节点的 /api/nodes/[id]/stream。 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const body = await readGroupJson(req);
    return Response.json(sendGroupMessage(id, body.text, body.provider));
  } catch (e) {
    return groupErrorResponse(e);
  }
}
