import { NextRequest } from "next/server";
import { requireSession } from "@/lib/server/auth-session";
import { listPasskeys } from "@/lib/server/passkeys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/passkeys → { passkeys: PasskeyListItem[] }
// 闸后（proxy.ts）+ 路由内再判会话（纵深防御）。不返回公钥等凭证材料。
export async function GET(req: NextRequest) {
  const denied = requireSession(req);
  if (denied) return denied;
  return Response.json({ passkeys: listPasskeys() }, { headers: { "cache-control": "no-store" } });
}
