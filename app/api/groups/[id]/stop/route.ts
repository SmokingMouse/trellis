import { groupErrorResponse, stopRound } from "@/lib/server/groups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 停下这一轮：正在说的那位立即中断，后面排着的不再开口。 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    return Response.json({ stopped: stopRound(id) });
  } catch (e) {
    return groupErrorResponse(e);
  }
}
