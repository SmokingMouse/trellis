import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 统一推送：中继认证、payload 改写、角标求和、网关接管的 /api/push/*。
// 真实网络发送被 setGatewayPushSenderForTests 替换；VAPID / tenants 目录都指到临时目录。
const dir = mkdtempSync(join(tmpdir(), "trellis-gw-push-"));
const prev = { tenants: process.env.TRELLIS_GW_TENANTS_DIR, vapid: process.env.TRELLIS_GW_PUSH_VAPID };
process.env.TRELLIS_GW_TENANTS_DIR = join(dir, "tenants");
process.env.TRELLIS_GW_PUSH_VAPID = join(dir, "state", "push-vapid.json");
const { mkdirSync } = await import("node:fs");
mkdirSync(join(dir, "tenants"));
const TENANT_TOKEN = "tenant-secret-admin";
writeFileSync(join(dir, "tenants", "host-admin.json"), JSON.stringify({ name: "host-admin", hostPort: 3088, authToken: TENANT_TOKEN }));
writeFileSync(join(dir, "tenants", "host-other.json"), JSON.stringify({ name: "host-other", hostPort: 3089, authToken: "tenant-secret-other" }));

const { openGatewayDB } = await import("./db");
const { addUser } = await import("./auth");
const { addNode } = await import("./tunnel");
const push = await import("./push");
const { authenticateRelay } = await import("./relay-auth");
import type { SessionUser } from "./auth";

afterAll(() => {
  push.setGatewayPushSenderForTests(null);
  for (const [k, v] of [["TRELLIS_GW_TENANTS_DIR", prev.tenants], ["TRELLIS_GW_PUSH_VAPID", prev.vapid]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const db = openGatewayDB(":memory:");
addUser(db, "admin", "host-admin", "admin");
addUser(db, "other", "host-other", "user");
const userOf = (name: string) => db.prepare("SELECT id,name,tenant,role FROM users WHERE name=?").get(name) as SessionUser;
const me = userOf("admin");
const other = userOf("other");
const officeToken = addNode(db, "office", me.id);
const otherToken = addNode(db, "other-box", other.id);
push.ensurePushTables(db);

type Sent = { endpoint: string; payload: Record<string, unknown> };
let sent: Sent[] = [];
let failWith: Record<string, number> = {};
beforeEach(() => {
  sent = [];
  failWith = {};
  db.exec("DELETE FROM push_subscriptions; DELETE FROM push_badges;");
  push.setGatewayPushSenderForTests(async (sub, body) => {
    const code = failWith[sub.endpoint];
    if (code) throw Object.assign(new Error(`HTTP ${code}`), { statusCode: code });
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(body) });
    return { statusCode: 201 };
  });
});

const subJSON = (n: string) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: "BKey", auth: "auth" } });
const payload = (over: Record<string, unknown> = {}) => ({
  kind: "done", title: "已完成 · 会话", body: "答完了", tag: "trellis:s1",
  url: "/?session=s1&node=n1", sessionId: "s1", nodeId: "n1", badge: 2, ...over,
});

function relay(headers: Record<string, string>, body: unknown = payload()): Request {
  return new Request("http://hub/__gw/relay/push", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function subscribe(user: SessionUser, n: string): Promise<Response> {
  const req = new Request("http://hub/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscription: subJSON(n) }),
  });
  return push.handleGatewayPush(req, new URL(req.url), user, db);
}

test("中继认证：远端 node token / tenant authToken 认得出机器与用户；错 token、冒名一律拒", () => {
  expect(authenticateRelay(db, relay({ authorization: `Bearer ${officeToken}`, "x-trellis-node": "office" })))
    .toEqual({ user: me, machine: "office" });
  expect(authenticateRelay(db, relay({ authorization: `Bearer ${TENANT_TOKEN}` })))
    .toEqual({ user: me, machine: "host-admin" });
  expect(authenticateRelay(db, relay({ authorization: `Bearer ${TENANT_TOKEN}`, "x-trellis-tenant": "host-admin" })))
    .toEqual({ user: me, machine: "host-admin" });
  // 错 token
  expect(authenticateRelay(db, relay({ authorization: "Bearer nope", "x-trellis-node": "office" }))).toBeNull();
  expect(authenticateRelay(db, relay({ authorization: "Bearer nope" }))).toBeNull();
  // 拿自己的 node token 冒充别人的机器
  expect(authenticateRelay(db, relay({ authorization: `Bearer ${otherToken}`, "x-trellis-node": "office" }))).toBeNull();
  // tenant token 对不上声明的 tenant
  expect(authenticateRelay(db, relay({ authorization: `Bearer ${TENANT_TOKEN}`, "x-trellis-tenant": "host-other" }))).toBeNull();
  expect(authenticateRelay(db, relay({}))).toBeNull();
});

test("/__gw/relay/push：错 token 401、不合法 payload 400；他人机器只发给他自己的订阅", async () => {
  await subscribe(me, "mine");
  await subscribe(other, "theirs");
  expect((await push.handleRelayPush(relay({ authorization: "Bearer bad", "x-trellis-node": "office" }), db)).status).toBe(401);
  expect((await push.handleRelayPush(relay({ authorization: `Bearer ${officeToken}`, "x-trellis-node": "office" }, { kind: "x" }), db)).status).toBe(400);
  expect(sent.length).toBe(0);

  const res = await push.handleRelayPush(relay({ authorization: `Bearer ${otherToken}`, "x-trellis-node": "other-box" }), db);
  expect(res.status).toBe(200);
  expect(sent.map((s) => s.endpoint)).toEqual(["https://push.example/theirs"]);
});

test("改写：url → /__gw/go/<机器>/...，tag 前缀机器名，多机标题带机器名，角标各机器求和", async () => {
  await subscribe(me, "phone");
  const office = { authorization: `Bearer ${officeToken}`, "x-trellis-node": "office" };
  const home = { authorization: `Bearer ${TENANT_TOKEN}` };
  expect((await push.handleRelayPush(relay(office, payload({ badge: 2 })), db)).status).toBe(200);
  expect(sent[0].payload).toMatchObject({
    title: "office · 已完成 · 会话",
    tag: "office:trellis:s1",
    url: "/__gw/go/office/?session=s1&node=n1",
    sessionId: "s1",
    badge: 2,
  });
  await push.handleRelayPush(relay(home, payload({ kind: "waiting", badge: 3, tag: "trellis:s1" })), db);
  expect(sent[1].payload).toMatchObject({ tag: "host-admin:trellis:s1", url: "/__gw/go/host-admin/?session=s1&node=n1", badge: 5 });
  // 不带 badge 的不动角标、也不记账
  await push.handleRelayPush(relay(office, payload({ badge: undefined })), db);
  expect(sent[2].payload.badge).toBeUndefined();
  // 开放重定向 / 套娃 url 一律退回首页
  await push.handleRelayPush(relay(office, payload({ url: "//evil.example/x" })), db);
  expect(sent[3].payload.url).toBe("/__gw/go/office/");
  await push.handleRelayPush(relay(office, payload({ url: "/__gw/go/other-box/" })), db);
  expect(sent[4].payload.url).toBe("/__gw/go/office/");
});

test("单机用户标题不加机器名", () => {
  const out = push.rewriteForMachine(push.parseRelayPayload(payload())!, "host-other", false);
  expect(out.title).toBe("已完成 · 会话");
  expect(out.tag).toBe("host-other:trellis:s1");
});

test("发送 404/410 删订阅、其它错误保留", async () => {
  await subscribe(me, "gone");
  await subscribe(me, "flaky");
  failWith = { "https://push.example/gone": 410, "https://push.example/flaky": 500 };
  const res = await push.handleRelayPush(relay({ authorization: `Bearer ${officeToken}`, "x-trellis-node": "office" }), db);
  const report = (await res.json()) as { sent: number; removed: number; failed: unknown[] };
  expect(report).toMatchObject({ sent: 0, removed: 1 });
  expect(report.failed.length).toBe(1);
  const left = db.prepare("SELECT endpoint FROM push_subscriptions").all() as { endpoint: string }[];
  expect(left.map((r) => r.endpoint)).toEqual(["https://push.example/flaky"]);
});

test("网关接管 /api/push/key|subscribe|test：公钥来自网关 VAPID（0600）、订阅按用户隔离", async () => {
  const keyReq = new Request("http://hub/api/push/key");
  const key = (await (await push.handleGatewayPush(keyReq, new URL(keyReq.url), me, db)).json()) as { publicKey: string };
  expect(key.publicKey).toBe(push.gatewayVapidKeys().publicKey);
  expect(statSync(process.env.TRELLIS_GW_PUSH_VAPID!).mode & 0o777).toBe(0o600);

  expect((await subscribe(me, "a")).status).toBe(200);
  const known = async (user: SessionUser) => {
    const req = new Request(`http://hub/api/push/subscribe?endpoint=${encodeURIComponent("https://push.example/a")}`);
    return (await push.handleGatewayPush(req, new URL(req.url), user, db)).json();
  };
  expect(await known(me)).toEqual({ known: true, total: 1 });
  expect(await known(other)).toEqual({ known: false, total: 0 });

  const testReq = new Request("http://hub/api/push/test", { method: "POST", body: "{}" });
  const r = (await (await push.handleGatewayPush(testReq, new URL(testReq.url), me, db)).json()) as { sent: number };
  expect(r.sent).toBe(1);
  expect(sent[0].payload).toMatchObject({ kind: "test", tag: "trellis:test" });

  // 别人删不掉我的订阅
  const del = (user: SessionUser) => {
    const req = new Request("http://hub/api/push/subscribe", { method: "DELETE", body: JSON.stringify({ endpoint: "https://push.example/a" }) });
    return push.handleGatewayPush(req, new URL(req.url), user, db).then((x) => x.json());
  };
  expect(await del(other)).toMatchObject({ removed: false });
  expect(await del(me)).toMatchObject({ removed: true, total: 0 });
});
