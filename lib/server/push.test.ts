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
const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const push = await import("./push");
const { persistPendingInteraction } = await import("./repo");

afterAll(() => {
  push.setPushSenderForTests(null);
  sqlite.resetDBForTests();
  if (prevDb === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = prevDb;
  if (prevVapid === undefined) delete process.env.TRELLIS_PUSH_VAPID_PATH;
  else process.env.TRELLIS_PUSH_VAPID_PATH = prevVapid;
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

test("pushTurnDone：带 payload 发出；同会话 30s 内去重；前台在看则不推；开关关闭不推", async () => {
  push.saveSubscription(sub("p"), null);
  const a = seedSession();
  push.pushTurnDone(a.nodeId);
  push.pushTurnDone(a.nodeId);
  await flush();
  expect(sent.length).toBe(1);
  expect(sent[0].payload).toMatchObject({ kind: "done", title: `已完成 · 会话${seq}`, body: "答完了", tag: `trellis:${a.sessionId}`, url: `/?session=${a.sessionId}&node=${a.nodeId}` });
  expect(sent[0].opts.urgency).toBe("normal");
  expect(sent[0].opts.topic?.length).toBe(32);

  const b = seedSession();
  push.reportPresence("client-1", b.sessionId, true);
  push.pushTurnDone(b.nodeId);
  await flush();
  expect(sent.length).toBe(1);
  push.reportPresence("client-1", b.sessionId, false);
  push.pushTurnDone(b.nodeId);
  await flush();
  expect(sent.length).toBe(2);

  const c = seedSession();
  sqlite.getDB().prepare("INSERT INTO app_settings(key,value,updated_at) VALUES ('push_done','0',1)").run();
  push.pushTurnDone(c.nodeId);
  await flush();
  expect(sent.length).toBe(2);
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
