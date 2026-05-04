import { markNodeRead } from "@/lib/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mark a node as read. Idempotent: repeat calls return the existing
// timestamp. Client-side "1s open in fullscreen" gate enforces the
// semantic — server doesn't validate dwell time.
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const readAt = markNodeRead(id, Date.now());
  if (readAt === null) {
    return Response.json({ error: "node not found" }, { status: 404 });
  }
  return Response.json({ readAt });
}
