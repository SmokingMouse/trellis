import { NextRequest } from "next/server";
import { requireSession } from "@/lib/server/auth-session";
import { beginRegistration, rpFromRequest } from "@/lib/server/passkeys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/passkeys/register/options → PublicKeyCredentialCreationOptionsJSON
// 只有已登录（有效会话 cookie）才能注册。RP 从 Origin 头推导并比对白名单。
export async function POST(req: NextRequest) {
  const denied = requireSession(req);
  if (denied) return denied;
  const rp = rpFromRequest(req);
  if (!rp) {
    return Response.json(
      { error: "当前访问地址不在 Passkey 白名单（TRELLIS_PASSKEY_ORIGINS）里，无法注册" },
      { status: 400 },
    );
  }
  return Response.json(await beginRegistration(rp), { headers: { "cache-control": "no-store" } });
}
