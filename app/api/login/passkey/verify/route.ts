import { NextRequest, NextResponse } from "next/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import {
  authGateEnabled,
  clientKey,
  issueSessionCookie,
  loginLimiter,
  tooManyAttempts,
} from "@/lib/server/auth-session";
import { finishLogin, rpFromRequest } from "@/lib/server/passkeys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/login/passkey/verify  body = AuthenticationResponseJSON
// 闸前公开（proxy.ts 白名单）。校验通过 → 用 issueSessionCookie 签发与口令登录**完全
// 相同**的会话 cookie。失败计入 passkey 自己的限速计数（与口令分开，见 auth-session.ts）。
export async function POST(req: NextRequest) {
  if (!authGateEnabled()) return Response.json({ error: "未启用登录闸" }, { status: 409 });
  const limiter = loginLimiter("passkey");
  const key = clientKey(req);
  const wait = limiter.blockedFor(key);
  if (wait > 0) return tooManyAttempts(wait);

  const rp = rpFromRequest(req);
  if (!rp) return Response.json({ ok: false, error: "当前访问地址未启用 Passkey" }, { status: 400 });

  let body: AuthenticationResponseJSON | null = null;
  try {
    body = (await req.json()) as AuthenticationResponseJSON;
  } catch {
    /* 坏 body → 下面按失败处理 */
  }
  const result = body ? await finishLogin(rp, body) : ({ ok: false, error: "请求格式不对" } as const);
  if (!result.ok) {
    limiter.recordFailure(key);
    return NextResponse.json({ ok: false, error: result.error }, { status: 401 });
  }
  limiter.recordSuccess(key);
  const res = NextResponse.json({ ok: true });
  issueSessionCookie(req, res);
  return res;
}
