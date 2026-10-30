import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE } from "@/lib/auth-cookie";

// Public-exposure auth gate (Next's "proxy" convention — formerly "middleware").
// trellis can spawn the claude/codex CLI with full permission (project/
// enhanced modes) — i.e. arbitrary code execution on the host. When
// served over the public tunnel (trellis.smokingmouse.cc) that endpoint MUST
// sit behind auth.
//
// Cookie session (not Basic Auth): /login posts the password to /api/login,
// which sets an httpOnly cookie = TRELLIS_AUTH_TOKEN on success. Here we just
// compare the cookie to the token. Page navigations without a valid cookie are
// redirected to the themed /login; API/asset requests get a plain 401.
//
// When TRELLIS_AUTH_PASS is unset the gate is OFF — local dev / Tailscale-
// private use stays frictionless; only the password-configured public deploy
// is protected.
const PASS = process.env.TRELLIS_AUTH_PASS;
const TOKEN = process.env.TRELLIS_AUTH_TOKEN;

// Always reachable without a session: the login page itself, the login API,
// and public/static assets the login page (and PWA shell) need.
//
// /api/hooks/claude is the one API exception. It carries its own bearer
// (X-Trellis-Hook-Token, compared in constant time against
// ~/.trellis/hooks/endpoint.env) because the caller is a `sh` hook fired by
// Claude Code — it has no browser and therefore no cookie. Only the ingest
// endpoint (plus its blocking long-poll twin) is opened; GET /api/hooks/state
// and the answer route /api/herdr/interactions/* stay behind the cookie gate.
function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/api/login" ||
    // Passkey 登录的两步（发 challenge / 验签名）本身就是登录入口，必须在闸前。
    // 只开这两条精确路径；注册、列表、删除（/api/passkeys/*）全在闸后。
    pathname === "/api/login/passkey/options" ||
    pathname === "/api/login/passkey/verify" ||
    pathname === "/api/hooks/claude" ||
    // 阻塞 hook 的长轮询：同一个 X-Trellis-Hook-Token 口令（agent-hooks/auth.ts），同理放行。
    pathname === "/api/hooks/claude/interaction" ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    pathname === "/icon.svg" ||
    pathname === "/apple-icon" ||
    pathname === "/manifest.json" ||
    // PWA / Web Push：service worker 脚本与 public/icons/ 下的静态 PNG。都是公开
    // 静态文件、不含任何数据；放开是因为浏览器在后台做 SW 更新检查、iOS 读主屏图标
    // 时未必带得上登录 cookie —— 401 会让 SW 更新失败 / 图标退化。订阅、发送等
    // /api/push/* 仍在下面的 cookie 闸后，不受影响。
    pathname === "/sw.js" ||
    /^\/icons\/[\w-]+\.png$/.test(pathname)
  );
}

export function proxy(req: NextRequest) {
  if (!PASS || !TOKEN) return NextResponse.next(); // gate disabled

  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  if (req.cookies.get(AUTH_COOKIE)?.value === TOKEN) {
    return NextResponse.next();
  }

  // Page navigation → send to the themed login page (remember where to return).
  const accept = req.headers.get("accept") || "";
  if (req.method === "GET" && accept.includes("text/html")) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?from=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }
  // API / fetch / asset → opaque 401 (the SPA shell is already gated above).
  return new NextResponse("Unauthorized", { status: 401 });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
