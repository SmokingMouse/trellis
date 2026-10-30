import { continueGroupRound, groupErrorResponse } from "@/lib/server/groups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 上限卡的「继续讨论」：再起一轮，从还排着的人接着说。{ provider? } → { round } */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const body = (await req.json().catch(() => ({}))) as { provider?: unknown };
    return Response.json({ round: continueGroupRound(id, body?.provider) });
  } catch (e) {
    return groupErrorResponse(e);
  }
}
