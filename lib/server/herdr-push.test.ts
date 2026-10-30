import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Herdr 窗格 → Web Push 的端到端（watcher + push.ts 出口 + 假发送 + 假时钟）。fleet / hook /
// transcript 经 HerdrPushDeps 注入，派生仍走真的 buildHerdrConsole。
mock.module("server-only", () => ({}));
const dir = mkdtempSync(path.join(tmpdir(), "trellis-herdr-push-"));
const prev = { db: process.env.TRELLIS_DB_PATH, vapid: process.env.TRELLIS_PUSH_VAPID_PATH, hubFile: process.env.TRELLIS_HUB_NODE_FILE };
process.env.TRELLIS_DB_PATH = path.join(dir, "data.db");
process.env.TRELLIS_PUSH_VAPID_PATH = path.join(dir, "push-vapid.json");
process.env.TRELLIS_HUB_NODE_FILE = path.join(dir, "hub-node.json");
delete process.env.TRELLIS_HUB_RELAY_URL;
delete process.env.TRELLIS_HUB_URL;
const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const push = await import("./push");
const { HerdrPushWatcher } = await import("./herdr-push");
const { FakeTimers } = await import("../__fixtures__/fake-timers");
const fx = await import("../__fixtures__/herdr-push-fleet");
const { HERDR_PUSH_FLICKER_MS } = await import("../herdr-push-watch");
import type { HerdrHookRecord } from "../herdr-ui";
import type { AgentHookRecord } from "./agent-hooks/types";

const clock = new FakeTimers(Date.now());
push.setPushTimersForTests(clock);

afterAll(() => {
  push.setPushSenderForTests(null);
  push.setPushTimersForTests(null);
  sqlite.resetDBForTests();
  for (const [k, v] of [["TRELLIS_DB_PATH", prev.db], ["TRELLIS_PUSH_VAPID_PATH", prev.vapid], ["TRELLIS_HUB_NODE_FILE", prev.hubFile]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

type Sent = { payload: Record<string, unknown>; opts: { TTL: number; urgency: string; topic?: string } };
let sent: Sent[] = [];
const flush = () => new Promise((r) => setTimeout(r, 10));

// 现场：每个用例自己改，watcher 每次 evaluate 现读。
let status = "working";
let hook: HerdrHookRecord | null = null;
let bound = true;
let fullHook: Partial<AgentHookRecord> = {};
let transcript: string[] | null = null;

let unseen: (() => void) | null = null;
function makeWatcher() {
  unseen?.();
  const w = new HerdrPushWatcher(
    {
      panes: (now) => fx.herdrPanes(status, hook, now, { bound, transcriptPath: transcript ? "/tmp/t.jsonl" : null }),
      hookRecord: () => ({ subagents: [], lastAssistantMessage: null, transcriptPath: null, ...fullHook }) as AgentHookRecord,
      transcriptLines: () => transcript,
    },
    clock,
  );
  // 与 startHerdrPushWatch 同样接上前台心跳。
  unseen = push.onPresenceSeen((sessionId) => w.done.seen(sessionId));
  return w;
}

beforeEach(() => {
  sent = [];
  status = "working";
  hook = null;
  bound = true;
  fullHook = {};
  transcript = null;
  // 待处理快照挂 globalThis、跨测试文件共享：清掉，角标只算本文件的 Herdr 项。
  (globalThis as { trellisPendingSnapshot?: unknown }).trellisPendingSnapshot = undefined;
  sqlite.getDB().exec("DELETE FROM push_subscriptions; DELETE FROM app_settings;");
  push.saveSubscription({ endpoint: "https://push.example/h", p256dh: "BKey", auth: "auth" }, null);
  push.setPushSenderForTests(async (_sub, body, opts) => {
    sent.push({ payload: JSON.parse(body), opts });
    return { statusCode: 201 };
  });
  // 去重 / 心跳表是进程级的：时间往前跳过窗口，别让上一个用例的记录挡住。
  clock.advance(10 * 60_000);
});

const kinds = () => sent.map((s) => s.payload.kind);

test("进入「需要你」立即推：标题写清 workspace / tab、正文是问的什么、url 直达窗格；同一交互只推一次", async () => {
  const w = makeWatcher();
  w.evaluate();
  status = "blocked";
  hook = fx.approvalHook("tu-1", "git push origin main", clock.now());
  w.evaluate();
  w.evaluate();
  await flush();
  expect(sent.length).toBe(1);
  expect(sent[0].payload).toMatchObject({
    kind: "waiting",
    title: "需要你 · trellis · review",
    body: "要执行 Bash：git push origin main",
    tag: `trellis:herdr:${fx.PANE_ID}`,
    url: `/?session=${fx.SESSION_ID}&pane=w1%3Ap1`,
    sessionId: fx.SESSION_ID,
    badge: 1,
  });
  expect(sent[0].opts.urgency).toBe("high");
});

test("没绑会话的窗格：url 落到总览 + 窗格定位", async () => {
  bound = false;
  const w = makeWatcher();
  w.evaluate();
  status = "blocked";
  w.evaluate();
  await flush();
  expect(sent[0].payload).toMatchObject({ kind: "waiting", url: "/?view=herdr&pane=w1%3Ap1", sessionId: null, body: "终端在等你输入" });
});

test("被答掉：过抖动窗口后同 tag 收回（角标归零）；紧接着的下一张卡不被去重窗口挡住", async () => {
  const w = makeWatcher();
  w.evaluate();
  status = "blocked";
  hook = fx.approvalHook("tu-1", "a", clock.now());
  w.evaluate();
  status = "working";
  hook = null;
  w.evaluate();
  clock.advance(HERDR_PUSH_FLICKER_MS - 1);
  await flush();
  expect(kinds()).toEqual(["waiting"]);
  clock.advance(1);
  await flush();
  expect(kinds()).toEqual(["waiting", "resolved"]);
  expect(sent[1].payload).toMatchObject({ tag: `trellis:herdr:${fx.PANE_ID}`, title: "已处理 · trellis · review", badge: 0 });
  expect(sent[1].opts.topic).toBe(sent[0].opts.topic);
  // 5 秒后又来一张卡（仍在 30s 去重窗口内）：照推
  clock.advance(5_000);
  status = "blocked";
  hook = fx.askHook("tu-2", "继续吗？", clock.now());
  w.evaluate();
  await flush();
  expect(kinds()).toEqual(["waiting", "resolved", "waiting"]);
});

test("抖动：短暂掉出 need 又回到同一张卡 → 不收回、不重推", async () => {
  const w = makeWatcher();
  w.evaluate();
  status = "blocked";
  hook = fx.approvalHook("tu-1", "a", clock.now());
  w.evaluate();
  status = "working";
  const saved = hook;
  hook = null;
  w.evaluate();
  clock.advance(2_000);
  status = "blocked";
  hook = saved;
  w.evaluate();
  clock.advance(HERDR_PUSH_FLICKER_MS * 2);
  await flush();
  expect(kinds()).toEqual(["waiting"]);
});

test("前台心跳与现有规则一致：正看着这个会话就不推；开关关了也不推", async () => {
  const w = makeWatcher();
  w.evaluate();
  push.reportPresence("c1", fx.SESSION_ID, true);
  status = "blocked";
  hook = fx.approvalHook("tu-1", "a", clock.now());
  w.evaluate();
  await flush();
  expect(sent.length).toBe(0);
  push.reportPresence("c1", fx.SESSION_ID, false);

  sqlite.getDB().prepare("INSERT INTO app_settings(key,value,updated_at) VALUES ('push_waiting','0',1)").run();
  hook = fx.askHook("tu-2", "x", clock.now());
  w.evaluate();
  await flush();
  expect(sent.length).toBe(0);
});

test("已完成：60s 后才推，正文取 hook 的最后一条回复；延迟内又干活 / 看过则不推", async () => {
  fullHook = { lastAssistantMessage: "**全部测试通过**，已提交。" };
  const w = makeWatcher();
  w.evaluate();
  status = "idle";
  w.evaluate();
  clock.advance(59_999);
  await flush();
  expect(sent.length).toBe(0);
  clock.advance(1);
  await flush();
  expect(sent.map((s) => s.payload)).toMatchObject([
    { kind: "done", title: "已完成 · trellis · review", body: "全部测试通过，已提交。", tag: `trellis:herdr:${fx.PANE_ID}`, url: `/?session=${fx.SESSION_ID}` },
  ]);

  // 又干活
  sent = [];
  clock.advance(60_000);
  status = "working";
  w.evaluate();
  status = "idle";
  w.evaluate();
  clock.advance(10_000);
  status = "working";
  w.evaluate();
  clock.advance(60_000);
  await flush();
  expect(sent.length).toBe(0);

  // 看过
  status = "idle";
  w.evaluate();
  clock.advance(5_000);
  push.reportPresence("c2", fx.SESSION_ID, true);
  push.reportPresence("c2", fx.SESSION_ID, false);
  clock.advance(60_000);
  await flush();
  expect(sent.length).toBe(0);
});

test("已完成：结束时后台任务还在跑 → 等回报唤起的那一轮结束才推，只推一次", async () => {
  const started = [
    JSON.stringify({ type: "user", message: { content: "跑全量测试" } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "Command running in background with ID: bg1. Output is being written to: /tmp/o" }] } }),
  ];
  transcript = started;
  const w = makeWatcher();
  w.evaluate();
  status = "idle";
  w.evaluate();
  clock.advance(120_000);
  await flush();
  expect(sent.length).toBe(0);

  // 后台任务回报 → 唤起一轮 → 结束
  transcript = [...started, JSON.stringify({ type: "user", origin: { kind: "task-notification" }, message: { content: "<task-notification>\n<task-id>bg1</task-id>\n</task-notification>" } })];
  status = "working";
  w.evaluate();
  status = "idle";
  w.evaluate();
  clock.advance(60_000);
  await flush();
  expect(kinds()).toEqual(["done"]);
  clock.advance(10 * 60_000);
  await flush();
  expect(kinds()).toEqual(["done"]);
});

test("读不到 transcript 时退回 hook 的子 agent 名单判后台", async () => {
  fullHook = { subagents: ["Explore"] };
  const w = makeWatcher();
  w.evaluate();
  status = "idle";
  w.evaluate();
  clock.advance(60_000);
  await flush();
  expect(sent.length).toBe(0);
  expect(w.probeDone(fx.PANE_ID)).toMatchObject({ status: "done", background: true });
});
