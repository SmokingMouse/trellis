import { NextRequest, NextResponse } from "next/server";

// Public-exposure auth gate. trellis can spawn the claude/codex CLI with full
// permission (workspace/project/enhanced modes) — i.e. arbitrary code execution
// on the host. When served over the public tunnel (trellis.smokingmouse.cc)
// that endpoint MUST sit behind auth. We use HTTP Basic over the HTTPS tunnel:
// browser-native (a login prompt, works on mobile), no login page to build, and
// the browser re-attaches the credentials to every same-origin request (so the
// SSE stream + /api/chat fetches carry it automatically).
//
// Set TRELLIS_AUTH_PASS (and optionally TRELLIS_AUTH_USER) in .env.local. When
// no password is set the gate is OFF — so local dev / Tailscale-private use
// stays frictionless and only the public deploy is protected.
const USER = process.env.TRELLIS_AUTH_USER || "trellis";
const PASS = process.env.TRELLIS_AUTH_PASS;

function unauthorized() {
  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Trellis", charset="UTF-8"' },
  });
}

export function middleware(req: NextRequest) {
  if (!PASS) return NextResponse.next(); // gate disabled (no password configured)

  const header = req.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return unauthorized();

  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return unauthorized();
  }
  const sep = decoded.indexOf(":");
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  if (user === USER && pass === PASS) return NextResponse.next();
  return unauthorized();
}

// Guard everything except Next's static asset routes (those carry no secrets
// and excluding them avoids re-prompting for every chunk). /api/* IS guarded —
// that's where the code-execution endpoints live.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
