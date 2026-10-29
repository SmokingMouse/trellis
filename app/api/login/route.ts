import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE } from "@/lib/auth-cookie";
import {
  authGateEnabled,
  clientKey,
  issueSessionCookie,
  loginLimiter,
  passwordMatches,
  tooManyAttempts,
} from "@/lib/server/auth-session";

export const runtime = "nodejs";

// POST { password } → set the session cookie on match. The cookie holds the
// server token (never the password), so rotating TRELLIS_AUTH_TOKEN logs
// everyone out. Cookie 的签发（属性、secure 判据）收在 lib/server/auth-session.ts
// 的 issueSessionCookie —— Passkey 登录走同一个函数，两条路签出的 cookie 完全相同。
//
// sameSite 是 strict 而不是 lax：lax 会在**跨站顶层导航**时照发 cookie，于是
// 任意外部页面都能把浏览器导到 `/term/?arg=…`（ttyd 以 `-W` 可写起，命令整个
// 走 URL 的 `?arg=`，见 lib/server/ttyd.ts:236-240/295），等于隔站驱动一个宿主
// shell。strict 把这条通道从根上掐掉。代价为零：入口是书签 / PWA / 直接输地址
// （strict 对这三种照发），notify.ts 走本机命令、不发回链，全库没有从外站导航
// 进来的深链。程序化调用（server.ts:204、scripts/deploy.ts、trellisctl）自己塞
// cookie header，不受 SameSite 约束。
//
// 失败限速：同一客户端 15 分钟内错 10 次、或全体合计错 50 次即 429 到窗口结束
// （见 auth-session.ts 的 loginLimiter；Passkey 用独立计数，口令被爆破时它仍可用）。
export async function POST(req: NextRequest) {
  if (!authGateEnabled()) {
    // Gate disabled — nothing to log into.
    return NextResponse.json({ ok: true });
  }
  const limiter = loginLimiter("password");
  const key = clientKey(req);
  const wait = limiter.blockedFor(key);
  if (wait > 0) return tooManyAttempts(wait);

  let password = "";
  try {
    const raw = (await req.json())?.password;
    password = typeof raw === "string" ? raw : "";
  } catch {
    /* empty body → fails the check below */
  }
  if (!passwordMatches(password)) {
    limiter.recordFailure(key);
    return NextResponse.json({ ok: false, error: "密码错误" }, { status: 401 });
  }
  limiter.recordSuccess(key);
  const res = NextResponse.json({ ok: true });
  issueSessionCookie(req, res);
  return res;
}

// DELETE → clear the cookie (logout).
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
