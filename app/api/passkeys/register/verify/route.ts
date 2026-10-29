import { NextRequest } from "next/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { requireSession } from "@/lib/server/auth-session";
import { finishRegistration, rpFromRequest, sanitizePasskeyName } from "@/lib/server/passkeys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/passkeys/register/verify  body = { name?: string, response: RegistrationResponseJSON }
// → { passkey: PasskeyListItem }。已登录才可用；challenge 一次性，失败需重新发起。
export async function POST(req: NextRequest) {
  const denied = requireSession(req);
  if (denied) return denied;
  const rp = rpFromRequest(req);
  if (!rp) return Response.json({ error: "当前访问地址不在 Passkey 白名单里" }, { status: 400 });

  let body: { name?: unknown; response?: RegistrationResponseJSON } | null = null;
  try {
    body = await req.json();
  } catch {
    /* 下面统一 400 */
  }
  if (!body?.response) return Response.json({ error: "请求格式不对" }, { status: 400 });

  const result = await finishRegistration(rp, body.response, sanitizePasskeyName(body.name));
  if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
  return Response.json({ passkey: result.value });
}
