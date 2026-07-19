import { markNodeRead, markNodeUnread } from "@/lib/server/repo";

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

// 手动标回未读：DELETE 掉 read 标记。幂等。视口自动已读的抑制（否则标完
// 未读、卡片还在视口里，1s 后又被标回）在客户端（store unreadHolds）。
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!markNodeUnread(id)) {
    return Response.json({ error: "node not found" }, { status: 404 });
  }
  return Response.json({ readAt: null });
}
