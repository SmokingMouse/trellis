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
function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/api/login" ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    pathname === "/icon.svg" ||
    pathname === "/apple-icon" ||
    pathname === "/manifest.json"
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
