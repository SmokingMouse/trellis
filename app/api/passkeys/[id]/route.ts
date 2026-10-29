import { NextRequest } from "next/server";
import { requireSession } from "@/lib/server/auth-session";
import { deletePasskey } from "@/lib/server/passkeys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// DELETE /api/passkeys/[id] → 删除一把 passkey，立即不能再用它登录。
// 已签发的 cookie 不受影响（cookie 与登录方式无关，要全员下线请轮换 TRELLIS_AUTH_TOKEN）。
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireSession(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!deletePasskey(id)) return Response.json({ error: "passkey not found" }, { status: 404 });
  return Response.json({ ok: true });
}
