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
    sameSite: "lax",
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
