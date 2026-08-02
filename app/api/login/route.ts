import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE } from "@/lib/auth-cookie";

export const runtime = "nodejs";

const PASS = process.env.TRELLIS_AUTH_PASS;
const TOKEN = process.env.TRELLIS_AUTH_TOKEN;
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// POST { password } → set the session cookie on match. The cookie holds the
// server token (never the password), so rotating TRELLIS_AUTH_TOKEN logs
// everyone out. secure is keyed off the forwarded proto so it's set over the
// HTTPS tunnel but not over plain-http localhost (where the browser would drop
// a secure cookie).
//
// sameSite 是 strict 而不是 lax：lax 会在**跨站顶层导航**时照发 cookie，于是
// 任意外部页面都能把浏览器导到 `/term/?arg=…`（ttyd 以 `-W` 可写起，命令整个
// 走 URL 的 `?arg=`，见 lib/server/ttyd.ts:236-240/295），等于隔站驱动一个宿主
// shell。strict 把这条通道从根上掐掉。代价为零：入口是书签 / PWA / 直接输地址
// （strict 对这三种照发），notify.ts 走本机命令、不发回链，全库没有从外站导航
// 进来的深链。程序化调用（server.ts:204、scripts/deploy.ts、trellisctl）自己塞
// cookie header，不受 SameSite 约束。
export async function POST(req: NextRequest) {
  if (!PASS || !TOKEN) {
    // Gate disabled — nothing to log into.
    return NextResponse.json({ ok: true });
  }
  let password = "";
  try {
    password = (await req.json())?.password ?? "";
  } catch {
    /* empty body → fails the check below */
  }
  if (password !== PASS) {
    return NextResponse.json({ ok: false, error: "密码错误" }, { status: 401 });
  }
  const secure = (req.headers.get("x-forwarded-proto") ?? "").includes("https");
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, TOKEN, {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: "/",
    maxAge: MAX_AGE,
  });
  return res;
}

// DELETE → clear the cookie (logout).
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
