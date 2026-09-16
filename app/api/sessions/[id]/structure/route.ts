import { getSession, listSessionChains } from "@/lib/server/repo";
import { groupSessionStructure } from "@/lib/recent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const session = getSession(id);
  if (!session) return Response.json({ error: "not found" }, { status: 404 });

  const rows = listSessionChains(id);
  const trees = groupSessionStructure(rows);
  return Response.json({ sessionId: id, trees });
}
