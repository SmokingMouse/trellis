import { cancelRegistration, getRegistration } from "@/lib/server/lark/register";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await ctx.params;
  const session = getRegistration(sessionId);
  if (!session) {
    return Response.json({ error: "会话不存在或已过期" }, { status: 404 });
  }
  return Response.json(session);
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await ctx.params;
  const session = getRegistration(sessionId);
  if (!session) {
    return Response.json({ error: "会话不存在或已结束" }, { status: 404 });
  }
  cancelRegistration(sessionId);
  return Response.json({ ok: true });
}
