import { listRuns } from "@/lib/server/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 30);
  return Response.json({ runs: listRuns(id, Number.isFinite(limit) ? limit : 30) });
}
