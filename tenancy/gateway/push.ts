// hub 的统一推送：经 hub 访问时所有机器同源，浏览器只有一份订阅。如果让各机器各用
// 自己的 VAPID，前端发现公钥不同就退订重订（lib/push-client.ts），最后只有一台能推。
// 所以经 hub 时：
//
// - 网关自己持一套 VAPID（网关状态目录下 push-vapid.json，0600），订阅存网关 DB（按用户）。
//   /api/push/key、/api/push/subscribe（GET/POST/DELETE）、/api/push/test 由这里接住，不落到 node。
//   其余 push 接口（presence 心跳等）照旧代理到当前 node——前台抑制、开关、去重都留在 node。
// - 各机器触发推送时把 payload POST 到 /__gw/relay/push（凭证见 relay-auth.ts）。这里把
//   点击链接改写成 /__gw/go/<机器>/...（落到对的机器），tag 前缀机器名（不同机器同 tag
//   不互相覆盖），用户有多台机器时标题带机器名，角标取各机器最近一次上报之和，再用网关
//   VAPID 发给该用户的全部订阅；404/410 删订阅。

import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import type { SessionUser } from "./auth";
import { gatewayDBPath } from "./db";
import { machineNames } from "./node-targets";
import { authenticateRelay } from "./relay-auth";
import { goHref } from "../../lib/gw-client";
import { isGoneStatus, parseSubscription, type PushPayload } from "../../lib/push";
import {
  loadOrCreateVapid,
  safeHost,
  sendOptionsFor,
  webPushSend,
  type PushSendOptions,
  type PushTarget,
  type VapidKeys,
} from "../../lib/push-send";

// ── 密钥 / 表 ───────────────────────────────────────────────────────────────

let vapid: { file: string; keys: VapidKeys } | null = null;

/** TRELLIS_GW_PUSH_VAPID 覆盖路径（测试用）；默认与网关 DB 同目录。 */
export function gatewayVapidPath(): string {
  return process.env.TRELLIS_GW_PUSH_VAPID || join(dirname(gatewayDBPath()), "push-vapid.json");
}

export function gatewayVapidKeys(): VapidKeys {
  const file = gatewayVapidPath();
  if (vapid?.file !== file) vapid = { file, keys: loadOrCreateVapid(file) };
  return vapid.keys;
}

export function ensurePushTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      ua TEXT,
      created_at INTEGER NOT NULL,
      last_ok_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS push_badges (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      machine TEXT NOT NULL,
      badge INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, machine)
    );
  `);
}

function countFor(db: Database, user: SessionUser): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id=?").get(user.id) as { n: number }).n;
}

// ── 发送 ───────────────────────────────────────────────────────────────────

type Sender = (sub: PushTarget, body: string, opts: PushSendOptions) => Promise<{ statusCode: number }>;
let testSender: Sender | null = null;

/** 测试注入：替换真实的网络发送。传 null 恢复。 */
export function setGatewayPushSenderForTests(sender: Sender | null): void {
  testSender = sender;
}

export type SendReport = {
  sent: number;
  removed: number;
  failed: { endpointHost: string; status: number | null; message: string }[];
};

export async function sendToUser(
  db: Database,
  user: SessionUser,
  payload: PushPayload,
  opts: { endpoint?: string } = {},
): Promise<SendReport> {
  ensurePushTables(db);
  const subs = (opts.endpoint
    ? db.prepare("SELECT endpoint,p256dh,auth FROM push_subscriptions WHERE user_id=? AND endpoint=?").all(user.id, opts.endpoint)
    : db.prepare("SELECT endpoint,p256dh,auth FROM push_subscriptions WHERE user_id=?").all(user.id)) as PushTarget[];
  const sender = testSender ?? ((sub, body, o) => webPushSend(gatewayVapidKeys(), sub, body, o));
  const body = JSON.stringify(payload);
  const sendOpts = sendOptionsFor(payload.kind, payload.tag);
  const report: SendReport = { sent: 0, removed: 0, failed: [] };
  await Promise.all(subs.map(async (sub) => {
    const host = safeHost(sub.endpoint);
    try {
      await sender(sub, body, sendOpts);
      report.sent++;
      db.prepare("UPDATE push_subscriptions SET last_ok_at=? WHERE endpoint=?").run(Date.now(), sub.endpoint);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (isGoneStatus(status)) {
        db.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").run(sub.endpoint);
        report.removed++;
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      report.failed.push({ endpointHost: host, status: status ?? null, message: message.slice(0, 200) });
      console.warn(`[trellis-gw] push 发往 ${host} 失败（${status ?? "network"}）：${message}`);
    }
  }));
  return report;
}

// ── 中继 payload 改写 ───────────────────────────────────────────────────────

// resolved：收回同 tag 的「需要你」（node 侧 lib/server/herdr-push.ts 发，SW 静默替换后关掉）。
const KINDS = new Set(["done", "waiting", "test", "resolved"]);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** node 发来的 JSON → 校验后的 PushPayload；不合法返回 null。 */
export function parseRelayPayload(raw: unknown): PushPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== "string" || !KINDS.has(r.kind)) return null;
  if (typeof r.title !== "string" || typeof r.tag !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" && v ? clip(v, 256) : null);
  const badge = typeof r.badge === "number" && Number.isInteger(r.badge) && r.badge >= 0 ? Math.min(r.badge, 9999) : undefined;
  return {
    kind: r.kind as PushPayload["kind"],
    title: clip(r.title, 200),
    body: typeof r.body === "string" ? clip(r.body, 500) : "",
    tag: clip(r.tag, 200),
    url: typeof r.url === "string" ? clip(r.url, 1024) : "/",
    sessionId: str(r.sessionId),
    nodeId: str(r.nodeId),
    ...(badge !== undefined ? { badge } : {}),
  };
}

/** 只认站内相对路径；//evil、/__gw/... 一律退回 "/"（防开放重定向 / 套娃）。 */
function siteRelative(url: string): string {
  if (!url.startsWith("/") || url.startsWith("//") || url.startsWith("/\\") || url.startsWith("/__gw/")) return "/";
  return url;
}

/** 按机器改写：点击落到 /__gw/go/<机器>/...、tag 前缀机器名、多机时标题带机器名。 */
export function rewriteForMachine(payload: PushPayload, machine: string, multiMachine: boolean): PushPayload {
  return {
    ...payload,
    title: multiMachine ? `${machine} · ${payload.title}` : payload.title,
    tag: `${machine}:${payload.tag}`,
    url: goHref(machine, siteRelative(payload.url)),
  };
}

/** 记下这台机器最近一次角标，返回该用户各机器之和（只算还挂在他名下的机器）。 */
export function recordBadge(db: Database, user: SessionUser, machine: string, badge: number): number {
  ensurePushTables(db);
  db.prepare(`
    INSERT INTO push_badges (user_id,machine,badge,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id,machine) DO UPDATE SET badge=excluded.badge, updated_at=excluded.updated_at
  `).run(user.id, machine, badge, Date.now());
  const names = new Set(machineNames(db, user));
  const rows = db.prepare("SELECT machine,badge FROM push_badges WHERE user_id=?").all(user.id) as { machine: string; badge: number }[];
  return rows.filter((r) => names.has(r.machine)).reduce((sum, r) => sum + r.badge, 0);
}

/** POST /__gw/relay/push：机器凭证认证，不走用户 session。 */
export async function handleRelayPush(req: Request, db: Database): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const who = authenticateRelay(db, req);
  if (!who) return Response.json({ error: "unauthorized" }, { status: 401 });
  let payload: PushPayload | null;
  try {
    payload = parseRelayPayload(await req.json());
  } catch {
    payload = null;
  }
  if (!payload) return Response.json({ error: "invalid payload" }, { status: 400 });
  const multi = machineNames(db, who.user).length > 1;
  const out = rewriteForMachine(payload, who.machine, multi);
  if (payload.badge !== undefined) out.badge = recordBadge(db, who.user, who.machine, payload.badge);
  const report = await sendToUser(db, who.user, out);
  return Response.json(report);
}

// ── 浏览器侧接口（经 hub 时替代 node 的 /api/push/key|subscribe|test）────────

export const GATEWAY_PUSH_PATHS = new Set(["/api/push/key", "/api/push/subscribe", "/api/push/test"]);

async function jsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = await req.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function handleGatewayPush(req: Request, url: URL, user: SessionUser, db: Database): Promise<Response> {
  ensurePushTables(db);
  const method = req.method;
  if (url.pathname === "/api/push/key") {
    if (method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    try {
      return Response.json({ publicKey: gatewayVapidKeys().publicKey });
    } catch (err) {
      console.error("[trellis-gw] push VAPID 密钥读取/生成失败：", err);
      return Response.json({ error: "推送密钥不可用" }, { status: 500 });
    }
  }

  if (url.pathname === "/api/push/subscribe") {
    if (method === "GET") {
      const endpoint = url.searchParams.get("endpoint") ?? "";
      const known = endpoint
        ? Boolean(db.prepare("SELECT 1 FROM push_subscriptions WHERE endpoint=? AND user_id=?").get(endpoint, user.id))
        : false;
      return Response.json({ known, total: countFor(db, user) });
    }
    if (method === "POST") {
      const body = await jsonBody(req);
      if (!body) return Response.json({ error: "invalid json" }, { status: 400 });
      const sub = parseSubscription(body.subscription);
      if (!sub) return Response.json({ error: "invalid subscription" }, { status: 400 });
      // 同一浏览器换账号登录：endpoint 归最后订阅的那个用户。
      db.prepare(`
        INSERT INTO push_subscriptions (endpoint,user_id,p256dh,auth,ua,created_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh,
          auth=excluded.auth, ua=excluded.ua
      `).run(sub.endpoint, user.id, sub.p256dh, sub.auth, req.headers.get("user-agent")?.slice(0, 300) ?? null, Date.now());
      return Response.json({ ok: true, total: countFor(db, user) });
    }
    if (method === "DELETE") {
      const body = await jsonBody(req);
      if (!body) return Response.json({ error: "invalid json" }, { status: 400 });
      if (typeof body.endpoint !== "string" || !body.endpoint) {
        return Response.json({ error: "endpoint required" }, { status: 400 });
      }
      const removed = db.prepare("DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?").run(body.endpoint, user.id).changes > 0;
      return Response.json({ ok: true, removed, total: countFor(db, user) });
    }
    return new Response("Method Not Allowed", { status: 405 });
  }

  // /api/push/test
  if (method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const body = (await jsonBody(req)) ?? {};
  const endpoint = typeof body.endpoint === "string" && body.endpoint ? body.endpoint : undefined;
  const report = await sendToUser(db, user, {
    kind: "test",
    title: "Trellis 测试推送",
    body: "能看到这条，说明 hub 推送已经通了（各台机器的通知都经这里发）",
    tag: "trellis:test",
    url: "/settings/prefs",
    sessionId: null,
    nodeId: null,
  }, { endpoint });
  return Response.json(report);
}
