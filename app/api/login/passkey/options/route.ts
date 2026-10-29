import { NextRequest } from "next/server";
import { authGateEnabled, clientKey, loginLimiter, tooManyAttempts } from "@/lib/server/auth-session";
import { beginLogin, rpFromRequest } from "@/lib/server/passkeys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/login/passkey/options → PublicKeyCredentialRequestOptionsJSON
// 闸前公开（proxy.ts 白名单）。只发一个绑定当前 origin 的一次性 challenge，不含任何
// credential 信息（discoverable 登录，allowCredentials 为空）。用 POST 是为了让浏览器
// 必带 Origin 头（同源 GET 不带）——RP 只从它推导。
export async function POST(req: NextRequest) {
  if (!authGateEnabled()) return Response.json({ error: "未启用登录闸" }, { status: 409 });
  const wait = loginLimiter("passkey").blockedFor(clientKey(req));
  if (wait > 0) return tooManyAttempts(wait);
  const rp = rpFromRequest(req);
  if (!rp) return Response.json({ error: "当前访问地址未启用 Passkey" }, { status: 400 });
  return Response.json(await beginLogin(rp), { headers: { "cache-control": "no-store" } });
}
