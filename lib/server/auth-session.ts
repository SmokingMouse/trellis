import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE } from "@/lib/auth-cookie";
import { FailureLimiter } from "@/lib/passkey";

// 登录会话的唯一签发点。口令登录（/api/login）与 Passkey 登录
// （/api/login/passkey/verify）都调 issueSessionCookie —— 两条路签出的 cookie
// 必须逐字节相同（同名、同值 = TRELLIS_AUTH_TOKEN、同属性），proxy.ts / server.ts
// 的闸只认这一种 cookie，不因登录方式不同而分叉。
//
// cookie 属性的取舍（sameSite strict 的理由）见 app/api/login/route.ts 顶部注释。

const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/** 与 proxy.ts / server.ts 同一判据：两个变量任一缺失 = 闸关。 */
export function authGateEnabled(): boolean {
  return Boolean(process.env.TRELLIS_AUTH_PASS && process.env.TRELLIS_AUTH_TOKEN);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** 口令比对（常量时间）。闸关时恒 false —— 调用方应先判 authGateEnabled。 */
export function passwordMatches(password: string): boolean {
  const pass = process.env.TRELLIS_AUTH_PASS;
  return Boolean(pass) && safeEqual(password, pass!);
}

/**
 * 请求是否带着有效会话 cookie。proxy.ts 已经在闸上挡过一遍；需要「必须已登录」
 * 语义的路由（注册 Passkey）再自己判一次，纵深防御 —— 万一将来 matcher / 白名单
 * 改漏了，也不会变成匿名可注册。闸关时返回 false（没有「已登录」这回事）。
 */
export function hasValidSession(req: NextRequest): boolean {
  const token = process.env.TRELLIS_AUTH_TOKEN;
  if (!authGateEnabled() || !token) return false;
  const v = req.cookies.get(AUTH_COOKIE)?.value;
  return typeof v === "string" && safeEqual(v, token);
}

/** 在响应上签发会话 cookie。只在校验通过后调用。 */
export function issueSessionCookie(req: NextRequest, res: NextResponse): void {
  const token = process.env.TRELLIS_AUTH_TOKEN;
  if (!token) throw new Error("TRELLIS_AUTH_TOKEN unset");
  // secure 按转发协议判：HTTPS 隧道下带上，纯 http 的 localhost 不带（否则浏览器丢弃）。
  const secure = (req.headers.get("x-forwarded-proto") ?? "").includes("https");
  res.cookies.set(AUTH_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: "/",
    maxAge: MAX_AGE,
  });
}

// ── 失败限速 ───────────────────────────────────────────────────────────────
//
// 口令与 Passkey 各一个计数器：口令被爆破触发全局封锁时，Passkey（不可爆破）仍能登录，
// 主人不会被攻击者顺手锁在门外。进程内存 + globalThis（Next 各路由 bundle 共享一份）；
// 重启清零可接受 —— 它是减速带，不是审计记录。
//
// key 取客户端 IP：cloudflared 隧道进来的请求由 Cloudflare 覆写 cf-connecting-ip；
// 直连（本机 / Tailscale）可伪造这些头，所以 per-key 之外还有 global 兜底。

const WINDOW_MS = 15 * 60_000;

const shared = globalThis as typeof globalThis & {
  __trellisLoginLimiters?: { password: FailureLimiter; passkey: FailureLimiter };
};

export function loginLimiter(kind: "password" | "passkey"): FailureLimiter {
  shared.__trellisLoginLimiters ??= {
    password: new FailureLimiter({ windowMs: WINDOW_MS, perKey: 10, global: 50 }),
    passkey: new FailureLimiter({ windowMs: WINDOW_MS, perKey: 20, global: 100 }),
  };
  return shared.__trellisLoginLimiters[kind];
}

export function clientKey(req: NextRequest): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return `ip:${cf.trim()}`;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return `ip:${xff.split(",")[0].trim()}`;
  return "direct";
}

/**
 * 「必须已登录」路由的守卫：闸关 → 409（没有登录这回事，passkey 无意义）；
 * 无有效 cookie → 401。通过返回 null。
 */
export function requireSession(req: NextRequest): Response | null {
  if (!authGateEnabled()) {
    return Response.json({ error: "未启用登录闸（TRELLIS_AUTH_PASS 未配置），Passkey 不可用" }, { status: 409 });
  }
  if (!hasValidSession(req)) return new Response("Unauthorized", { status: 401 });
  return null;
}

export function tooManyAttempts(retryMs: number): Response {
  const sec = Math.max(1, Math.ceil(retryMs / 1000));
  return Response.json(
    { ok: false, error: `尝试次数过多，请 ${Math.ceil(sec / 60)} 分钟后再试` },
    { status: 429, headers: { "retry-after": String(sec) } },
  );
}
