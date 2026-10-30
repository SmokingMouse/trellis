import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 订阅表 / 发送 / 触发门槛 / VAPID 落盘。真实网络发送被 setPushSenderForTests 替换；
// VAPID 文件经 TRELLIS_PUSH_VAPID_PATH 指到临时目录，绝不落到真 ~/.trellis
// （Bun 的 os.homedir() 不认进程内改写的 HOME，改 HOME 没用）。
mock.module("server-only", () => ({}));
const dir = mkdtempSync(path.join(tmpdir(), "trellis-push-"));
const prevDb = process.env.TRELLIS_DB_PATH;
const prevVapid = process.env.TRELLIS_PUSH_VAPID_PATH;
const vapidFile = path.join(dir, ".trellis", "push-vapid.json");
process.env.TRELLIS_DB_PATH = path.join(dir, "data.db");
process.env.TRELLIS_PUSH_VAPID_PATH = vapidFile;
// hub 中继：默认「没挂 hub」——别读到本机真的 ~/.trellis/hub-node.json / 环境变量。
const prevHub = { file: process.env.TRELLIS_HUB_NODE_FILE, url: process.env.TRELLIS_HUB_RELAY_URL, token: process.env.TRELLIS_AUTH_TOKEN, hubURL: process.env.TRELLIS_HUB_URL };
process.env.TRELLIS_HUB_NODE_FILE = path.join(dir, "hub-node.json");
delete process.env.TRELLIS_HUB_RELAY_URL;
delete process.env.TRELLIS_HUB_URL;
const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const push = await import("./push");
const { persistPendingInteraction } = await import("./repo");
const relayClient = await import("../hub-relay-client");
const { FakeTimers } = await import("../__fixtures__/fake-timers");
// 「已完成」的 60s 延迟、去重窗口、前台心跳都走 push.ts 的可注入时钟。整个文件共用一只、只往前走
// （去重 / 心跳表是进程级的，时间倒退会把上一个用例的记录误判成「窗口内」）。
const clock = new FakeTimers(Date.now());
push.setPushTimersForTests(clock);
const DELAY = 60_000;

afterAll(() => {
  push.setPushSenderForTests(null);
  push.setPushTimersForTests(null);
  sqlite.resetDBForTests();
  if (prevDb === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = prevDb;
  if (prevVapid === undefined) delete process.env.TRELLIS_PUSH_VAPID_PATH;
  else process.env.TRELLIS_PUSH_VAPID_PATH = prevVapid;
  relayClient.setHubRelayPosterForTests(null);
  for (const [k, v] of [["TRELLIS_HUB_NODE_FILE", prevHub.file], ["TRELLIS_HUB_RELAY_URL", prevHub.url], ["TRELLIS_AUTH_TOKEN", prevHub.token], ["TRELLIS_HUB_URL", prevHub.hubURL]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

type Sent = { endpoint: string; payload: Record<string, unknown>; opts: { TTL: number; urgency: string; topic?: string } };
let sent: Sent[] = [];
let failWith: Record<string, number> = {};

beforeEach(() => {
  sent = [];
  failWith = {};
  const db = sqlite.getDB();
  db.exec("DELETE FROM push_subscriptions; DELETE FROM app_settings;");
  push.setPushSenderForTests(async (sub, body, opts) => {
    const code = failWith[sub.endpoint];
    if (code) throw Object.assign(new Error(`HTTP ${code}`), { statusCode: code });
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(body), opts });
    return { statusCode: 201 };
  });
});

const sub = (n: string) => ({ endpoint: `https://push.example/${n}`, p256dh: "BKey", auth: "auth" });
const flush = () => new Promise((r) => setTimeout(r, 10));
let seq = 0;
function seedSession(): { sessionId: string; nodeId: string } {
  const id = `s${++seq}`;
  const db = sqlite.getDB();
  db.prepare("INSERT INTO sessions(id,title,root_node_id,created_at,updated_at) VALUES (?,?,?,1,1)").run(id, `会话${seq}`, `n${seq}`);
  db.prepare("INSERT INTO nodes(id,session_id,question,response,status,created_at) VALUES (?,?,'q','**答**完了','done',1)").run(`n${seq}`, id);
  return { sessionId: id, nodeId: `n${seq}` };
}

test("VAPID 首次生成落盘，权限 0600，之后复用", () => {
  const a = push.getVapidKeys();
  const file = vapidFile;
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(file, "utf8")).publicKey).toBe(a.publicKey);
  expect(a.publicKey.length).toBeGreaterThan(80);
  expect(push.getVapidKeys().privateKey).toBe(a.privateKey);
});

test("订阅 upsert 按 endpoint 唯一；发送 404/410 自动删、其它错误保留并上报", async () => {
  push.saveSubscription(sub("a"), "UA");
  push.saveSubscription({ ...sub("a"), auth: "auth2" }, "UA2");
  push.saveSubscription(sub("gone"), null);
  push.saveSubscription(sub("flaky"), null);
  expect(push.countSubscriptions()).toBe(3);
  failWith = { [sub("gone").endpoint]: 410, [sub("flaky").endpoint]: 500 };
  const r = await push.sendPush({ kind: "test", title: "t", body: "b", tag: "trellis:test", url: "/", sessionId: null, nodeId: null });
  expect(r.sent).toBe(1);
  expect(r.removed).toBe(1);
  expect(r.failed).toEqual([{ endpointHost: "push.example", status: 500, message: "HTTP 500" }]);
  expect(push.hasSubscription(sub("gone").endpoint)).toBe(false);
  expect(push.hasSubscription(sub("flaky").endpoint)).toBe(true);
  const row = sqlite.getDB().prepare("SELECT auth, last_ok_at FROM push_subscriptions WHERE endpoint = ?").get(sub("a").endpoint) as { auth: string; last_ok_at: number | null };
  expect(row.auth).toBe("auth2");
  expect(row.last_ok_at).toBeGreaterThan(0);
  // 只发给指定 endpoint
  const only = await push.sendPush({ kind: "test", title: "t", body: "b", tag: "x", url: "/", sessionId: null, nodeId: null }, { endpoint: sub("a").endpoint });
  expect(only.sent).toBe(1);
});

test("pushTurnDone：60s 后才推，带 payload；延迟内重复结束只推一次；开关关闭不推", async () => {
  push.saveSubscription(sub("p"), null);
  const a = seedSession();
  push.pushTurnDone(a.nodeId);
  push.pushTurnDone(a.nodeId);
  clock.advance(DELAY - 1);
  await flush();
  expect(sent.length).toBe(0);
  clock.advance(1);
  await flush();
  expect(sent.length).toBe(1);
  expect(sent[0].payload).toMatchObject({ kind: "done", title: `已完成 · 会话${seq}`, body: "答完了", tag: `trellis:${a.sessionId}`, url: `/?session=${a.sessionId}&node=${a.nodeId}` });
  expect(sent[0].opts.urgency).toBe("normal");
  expect(sent[0].opts.topic?.length).toBe(32);
  clock.advance(DELAY * 2);
  await flush();
  expect(sent.length).toBe(1);

  const c = seedSession();
  sqlite.getDB().prepare("INSERT INTO app_settings(key,value,updated_at) VALUES ('push_done','0',1)").run();
  push.pushTurnDone(c.nodeId);
  clock.advance(DELAY);
  await flush();
  expect(sent.length).toBe(1);
});

test("pushTurnDone：延迟窗口里在前台看过（哪怕之后切走）、或已读，就不推", async () => {
  push.saveSubscription(sub("seen"), null);
  const b = seedSession();
  push.pushTurnDone(b.nodeId);
  clock.advance(10_000);
  push.reportPresence("client-1", b.sessionId, true);
  clock.advance(10_000);
  push.reportPresence("client-1", b.sessionId, false);
  clock.advance(DELAY);
  await flush();
  expect(sent.length).toBe(0);

  // 结束时就在前台、到点前切走：也算看过
  const c = seedSession();
  push.reportPresence("client-2", c.sessionId, true);
  push.pushTurnDone(c.nodeId);
  push.reportPresence("client-2", c.sessionId, true);
  push.reportPresence("client-2", c.sessionId, false);
  clock.advance(DELAY);
  await flush();
  expect(sent.length).toBe(0);

  // 已读标记（/api/nodes/[id]/read）
  const d = seedSession();
  push.pushTurnDone(d.nodeId);
  sqlite.getDB().prepare("UPDATE nodes SET read_at = ? WHERE id = ?").run(clock.now(), d.nodeId);
  clock.advance(DELAY);
  await flush();
  expect(sent.length).toBe(0);

  // 没人看：照推
  const e = seedSession();
  push.pushTurnDone(e.nodeId);
  clock.advance(DELAY);
  await flush();
  expect(sent.map((x) => x.payload.sessionId)).toEqual([e.sessionId]);
});

test("pushTurnDone：延迟窗口里会话又开始干活（新节点），这一轮不推", async () => {
  push.saveSubscription(sub("again"), null);
  const a = seedSession();
  push.pushTurnDone(a.nodeId);
  clock.advance(5_000);
  sqlite.getDB().prepare("INSERT INTO nodes(id,session_id,question,response,status,created_at) VALUES (?,?,'q2','','streaming',2)").run(`${a.nodeId}-next`, a.sessionId);
  clock.advance(DELAY);
  await flush();
  expect(sent.length).toBe(0);
});

test("没有订阅时触发点什么都不做", async () => {
  const a = seedSession();
  push.pushTurnDone(a.nodeId);
  await flush();
  expect(sent.length).toBe(0);
});

test("触发点接线：节点出现待审批 → 快照重算 → 推「等你回答」", async () => {
  push.saveSubscription(sub("w"), null);
  const a = seedSession();
  persistPendingInteraction(a.nodeId, {
    toolUseId: "tu-1",
    toolName: "AskUserQuestion",
    input: { questions: [{ question: "用哪个分支？" }] },
  } as Parameters<typeof persistPendingInteraction>[1]);
  await flush();
  const waiting = sent.filter((s) => s.payload.kind === "waiting");
  expect(waiting.length).toBe(1);
  expect(waiting[0].payload).toMatchObject({ title: `等你回答 · 会话${seq}`, body: "用哪个分支？", sessionId: a.sessionId });
  expect(waiting[0].opts.urgency).toBe("high");

  // 关掉「等你回答」后新出现的项不推
  sqlite.getDB().prepare("INSERT INTO app_settings(key,value,updated_at) VALUES ('push_waiting','0',1)").run();
  const b = seedSession();
  persistPendingInteraction(b.nodeId, { toolUseId: "tu-2", toolName: "AskUserQuestion", input: {} } as Parameters<typeof persistPendingInteraction>[1]);
  await flush();
  expect(sent.filter((s) => s.payload.kind === "waiting").length).toBe(1);
});

test("挂在 hub 下：本机没有订阅也照样交给 hub 中继（tenant 凭证），本机订阅另走直发", async () => {
  type Posted = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
  const posted: Posted[] = [];
  relayClient.setHubRelayPosterForTests(async (url, init) => {
    posted.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return Response.json({ sent: 1, removed: 0, failed: [] });
  });
  process.env.TRELLIS_HUB_RELAY_URL = "http://127.0.0.1:3200/";
  process.env.TRELLIS_AUTH_TOKEN = "tenant-token";
  try {
    const a = seedSession();
    push.pushTurnDone(a.nodeId);
    clock.advance(DELAY);
    await flush();
    expect(sent.length).toBe(0);
    expect(posted.length).toBe(1);
    expect(posted[0].url).toBe("http://127.0.0.1:3200/__gw/relay/push");
    expect(posted[0].headers.authorization).toBe("Bearer tenant-token");
    expect(posted[0].body).toMatchObject({ kind: "done", sessionId: a.sessionId, url: `/?session=${a.sessionId}&node=${a.nodeId}` });
    expect(typeof posted[0].body.badge).toBe("number");

    // 本机也有直连订阅：两条路都走
    push.saveSubscription(sub("direct"), null);
    const b = seedSession();
    push.pushTurnDone(b.nodeId);
    clock.advance(DELAY);
    await flush();
    expect(sent.map((s) => s.endpoint)).toEqual([sub("direct").endpoint]);
    expect(posted.length).toBe(2);
  } finally {
    delete process.env.TRELLIS_HUB_RELAY_URL;
    delete process.env.TRELLIS_AUTH_TOKEN;
    relayClient.setHubRelayPosterForTests(null);
  }
});

test("远端 node：hub-node.json 优先，带 node token + x-trellis-node", async () => {
  const { writeHubNodeFile } = await import("../hub-node-config");
  writeHubNodeFile({ hubURL: "https://hub.example", nodeName: "office", nodeToken: "tn_x" }, process.env.TRELLIS_HUB_NODE_FILE);
  try {
    const t = relayClient.hubRelayTarget();
    expect(t).toEqual({ hubURL: "https://hub.example", headers: { authorization: "Bearer tn_x", "x-trellis-node": "office" }, via: "node" });
    expect(relayClient.hubRelayTarget({ ...process.env, TRELLIS_HUB_RELAY: "off" })).toBeNull();
  } finally {
    rmSync(process.env.TRELLIS_HUB_NODE_FILE!, { force: true });
  }
  expect(relayClient.hubRelayTarget()).toBeNull();
});
