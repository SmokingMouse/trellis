import { describe, expect, test } from "bun:test";
import {
  buildHerdrPushPayload,
  buildPushPayload,
  dedupeKey,
  isGoneStatus,
  isSessionForeground,
  newWaitingGroups,
  parsePushSettings,
  parseSubscription,
  plainSnippet,
  pushKindAllowed,
  recordPresence,
  takeDedupeSlot,
  waitingBadgeCount,
  PENDING_FRESH_MS,
  PENDING_STALE_MS,
  PRESENCE_TTL_MS,
  PUSH_DEDUPE_MS,
  type PresenceEntry,
} from "./push";
import { pendingKey, type PendingItem } from "./pending";

describe("parsePushSettings", () => {
  test("缺省全开，只有字面量 0 视为关", () => {
    expect(parsePushSettings(() => null)).toEqual({ enabled: true, done: true, waiting: true });
    const map: Record<string, string> = { push_enabled: "1", push_done: "0", push_waiting: " 0 " };
    expect(parsePushSettings((k) => map[k])).toEqual({ enabled: true, done: false, waiting: false });
  });
  test("总开关关掉时两类都不放行", () => {
    const s = parsePushSettings((k) => (k === "push_enabled" ? "0" : null));
    expect(pushKindAllowed(s, "done")).toBe(false);
    expect(pushKindAllowed(s, "waiting")).toBe(false);
    expect(pushKindAllowed(parsePushSettings(() => null), "waiting")).toBe(true);
  });
});

describe("buildPushPayload", () => {
  test("完成：标题带会话名，正文取回答开头的纯文本，tag 按会话、url 直达节点", () => {
    const p = buildPushPayload({
      kind: "done",
      sessionId: "s1",
      sessionTitle: "重构登录",
      nodeId: "n9",
      text: "## 结论\n\n**改好了**，见 `auth.ts`：\n```ts\nconst x = 1\n```\n- 第二点",
    });
    expect(p.title).toBe("已完成 · 重构登录");
    expect(p.body).toBe("结论 改好了，见 auth.ts： 第二点");
    expect(p.tag).toBe("trellis:s1");
    expect(p.url).toBe("/?session=s1&node=n9");
    expect(p.sessionId).toBe("s1");
  });
  test("等你回答：多项时附带数量，空标题兜底", () => {
    const p = buildPushPayload({ kind: "waiting", sessionId: "a b", sessionTitle: "  ", text: "要不要删表？", count: 3 });
    expect(p.title).toBe("等你回答 · 未命名会话");
    expect(p.body).toBe("要不要删表？（共 3 项）");
    expect(p.url).toBe("/?session=a+b");
  });
  test("超长正文截断带省略号", () => {
    const p = buildPushPayload({ kind: "done", sessionId: "s", text: "字".repeat(500) });
    expect(p.body.length).toBe(140);
    expect(p.body.endsWith("…")).toBe(true);
    expect(buildPushPayload({ kind: "done", sessionId: "s", text: "" }).body).toBe("这一轮跑完了");
  });
  test("plainSnippet 去掉链接与图片记号", () => {
    expect(plainSnippet("看 [文档](https://x.y) ![图](a.png) 完")).toBe("看 文档 完");
  });
});

describe("takeDedupeSlot", () => {
  test("同一会话同一类在窗口内只放行一次，换类型 / 过窗口后放行", () => {
    const m = new Map<string, number>();
    const k = dedupeKey("done", "s1");
    expect(takeDedupeSlot(m, k, 1000)).toBe(true);
    expect(takeDedupeSlot(m, k, 1000 + PUSH_DEDUPE_MS - 1)).toBe(false);
    expect(takeDedupeSlot(m, dedupeKey("waiting", "s1"), 2000)).toBe(true);
    expect(takeDedupeSlot(m, dedupeKey("done", "s2"), 2000)).toBe(true);
    expect(takeDedupeSlot(m, k, 1000 + PUSH_DEDUPE_MS)).toBe(true);
  });
  test("过期项被顺手清掉", () => {
    const m = new Map<string, number>([["old", 0]]);
    takeDedupeSlot(m, "new", PUSH_DEDUPE_MS * 2);
    expect(m.has("old")).toBe(false);
  });
});

describe("presence", () => {
  test("可见心跳在 TTL 内算前台，隐藏立刻撤销，过期自动失效", () => {
    const m = new Map<string, PresenceEntry>();
    recordPresence(m, "c1", "s1", true, 0);
    expect(isSessionForeground(m, "s1", 1)).toBe(true);
    expect(isSessionForeground(m, "s2", 1)).toBe(false);
    expect(isSessionForeground(m, "s1", PRESENCE_TTL_MS)).toBe(false);
    recordPresence(m, "c1", "s1", true, 10);
    recordPresence(m, "c1", "s1", false, 11);
    expect(isSessionForeground(m, "s1", 12)).toBe(false);
  });
  test("切会话时晚到的旧会话「不看了」不抹掉新会话", () => {
    const m = new Map<string, PresenceEntry>();
    recordPresence(m, "c1", "s1", true, 0);
    recordPresence(m, "c1", "s2", true, 5);
    recordPresence(m, "c1", "s1", false, 6);
    expect(isSessionForeground(m, "s2", 7)).toBe(true);
    recordPresence(m, "c1", null, false, 8);
    expect(isSessionForeground(m, "s2", 9)).toBe(false);
  });
  test("两个页面看同一会话，一个隐藏另一个仍算前台", () => {
    const m = new Map<string, PresenceEntry>();
    recordPresence(m, "phone", "s1", true, 0);
    recordPresence(m, "mac", "s1", true, 0);
    recordPresence(m, "phone", "s1", false, 1);
    expect(isSessionForeground(m, "s1", 2)).toBe(true);
  });
});

function item(over: Partial<PendingItem> & { sessionId: string; nodeId: string; toolUseId: string }): PendingItem {
  return {
    sessionTitle: `title-${over.sessionId}`,
    kind: "question",
    summary: `问 ${over.toolUseId}`,
    createdAt: 1_000_000,
    interaction: { toolUseId: over.toolUseId, toolName: "AskUserQuestion", input: {} },
    ...over,
  } as PendingItem;
}

describe("newWaitingGroups", () => {
  const now = 1_000_000;
  test("只挑上一版没有的项，按会话聚合计数", () => {
    const a = item({ sessionId: "s1", nodeId: "n1", toolUseId: "t1" });
    const b = item({ sessionId: "s1", nodeId: "n1", toolUseId: "t2" });
    const c = item({ sessionId: "s2", nodeId: "n2", toolUseId: "t3" });
    const groups = newWaitingGroups(new Set([pendingKey(a)]), [a, b, c], now);
    expect(groups).toEqual([
      { sessionId: "s1", sessionTitle: "title-s1", nodeId: "n1", summary: "问 t2", count: 1 },
      { sessionId: "s2", sessionTitle: "title-s2", nodeId: "n2", summary: "问 t3", count: 1 },
    ]);
    expect(newWaitingGroups(new Set(), [b, c].map((x) => ({ ...x, sessionId: "s9" })), now)[0].count).toBe(2);
  });
  test("进程首次算快照只推刚创建的，避免重启把挂着的老项全推一遍", () => {
    const fresh = item({ sessionId: "s1", nodeId: "n1", toolUseId: "t1", createdAt: now - 1000 });
    const old = item({ sessionId: "s2", nodeId: "n2", toolUseId: "t2", createdAt: now - PENDING_FRESH_MS - 1 });
    expect(newWaitingGroups(null, [fresh, old], now).map((g) => g.sessionId)).toEqual(["s1"]);
  });
  test("增量里过老的项（投影重建重新发现）不推", () => {
    const stale = item({ sessionId: "s1", nodeId: "n1", toolUseId: "t1", createdAt: now - PENDING_STALE_MS - 1 });
    expect(newWaitingGroups(new Set(), [stale], now)).toEqual([]);
  });
});

describe("parseSubscription", () => {
  const ok = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "BNc_x-1", auth: "aB-_9" } };
  test("合法订阅被扁平化", () => {
    expect(parseSubscription(ok)).toEqual({ endpoint: ok.endpoint, p256dh: "BNc_x-1", auth: "aB-_9" });
  });
  test("非 https、缺字段、非 base64url 一律拒", () => {
    expect(parseSubscription({ ...ok, endpoint: "http://x.y/z" })).toBeNull();
    expect(parseSubscription({ ...ok, endpoint: "not a url" })).toBeNull();
    expect(parseSubscription({ endpoint: ok.endpoint })).toBeNull();
    expect(parseSubscription({ ...ok, keys: { p256dh: "a b", auth: "x" } })).toBeNull();
    expect(parseSubscription(null)).toBeNull();
    expect(parseSubscription("x")).toBeNull();
  });
  test("404 / 410 视为订阅已失效", () => {
    expect(isGoneStatus(404)).toBe(true);
    expect(isGoneStatus(410)).toBe(true);
    expect(isGoneStatus(429)).toBe(false);
    expect(isGoneStatus(undefined)).toBe(false);
  });
});

describe("buildHerdrPushPayload", () => {
  test("需要你：标题带 workspace · tab，url 直达窗格（绑了会话进会话、没绑进总览），tag 按窗格", () => {
    const p = buildHerdrPushPayload({ kind: "waiting", paneId: "w1:p1", sessionId: "s1", where: "trellis · review", text: "提问：用哪个分支？" });
    expect(p).toMatchObject({ kind: "waiting", title: "需要你 · trellis · review", body: "提问：用哪个分支？", tag: "trellis:herdr:w1:p1", url: "/?session=s1&pane=w1%3Ap1" });
    expect(buildHerdrPushPayload({ kind: "waiting", paneId: "w1:p1", sessionId: null, where: "x" }).url).toBe("/?view=herdr&pane=w1%3Ap1");
  });
  test("已完成 / 收回与「需要你」同 tag（原地替换）", () => {
    const done = buildHerdrPushPayload({ kind: "done", paneId: "w1:p1", sessionId: "s1", where: "trellis · review", text: "**好了**" });
    expect(done).toMatchObject({ title: "已完成 · trellis · review", body: "好了", tag: "trellis:herdr:w1:p1", url: "/?session=s1" });
    const resolved = buildHerdrPushPayload({ kind: "resolved", paneId: "w1:p1", sessionId: null, where: "trellis · review" });
    expect(resolved).toMatchObject({ kind: "resolved", title: "已处理 · trellis · review", tag: "trellis:herdr:w1:p1" });
  });
  test("自起会话的「等你回答」url 带 focus=pending（落地滚到待处理卡）", () => {
    expect(buildPushPayload({ kind: "waiting", sessionId: "s1", nodeId: "n1" }).url).toBe("/?session=s1&node=n1&focus=pending");
    expect(buildPushPayload({ kind: "done", sessionId: "s1", nodeId: "n1" }).url).toBe("/?session=s1&node=n1");
  });
});

describe("waitingBadgeCount", () => {
  test("Herdr「需要你」的窗格也算；绑定的会话已在快照里的不重复算", () => {
    expect(waitingBadgeCount([{ sessionId: "a" }], [{ paneId: "p1", sessionId: "a" }, { paneId: "p2", sessionId: null }, { paneId: "p3", sessionId: "b" }])).toBe(3);
  });
  test("按会话去重计数", () => {
    expect(waitingBadgeCount([])).toBe(0);
    expect(waitingBadgeCount([{ sessionId: "a" }, { sessionId: "a" }, { sessionId: "b" }])).toBe(2);
  });
});
