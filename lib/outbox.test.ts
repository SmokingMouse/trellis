import { describe, expect, test } from "bun:test";
import {
  OUTBOX_MAX_AGE_MS,
  backoffMs,
  dueOutbox,
  enqueueOutbox,
  isRetriableStatus,
  markOutboxFailed,
  markOutboxRetry,
  networkTitle,
  newOutboxItem,
  outboxFor,
  parseOutbox,
  pendingOutboxCount,
  removeOutbox,
  serializeOutbox,
  wakeOutbox,
  type OutboxItem,
} from "./outbox";

const item = (id: string, target = "w1:p1", at = 1_000, kind: OutboxItem["kind"] = "herdr") =>
  newOutboxItem({ id, kind, target, text: `msg ${id}`, payload: {} }, at);

describe("Outbox 顺序", () => {
  test("同一 target 只发最早一条；前一条没发出去后面的都等着", () => {
    let items: OutboxItem[] = [];
    items = enqueueOutbox(items, item("a", "p1", 1));
    items = enqueueOutbox(items, item("b", "p1", 2));
    items = enqueueOutbox(items, item("c", "p2", 3));
    expect(dueOutbox(items, 10).map((i) => i.id)).toEqual(["a", "c"]);
    // a 失败进退避：p1 整条 lane 都等着，b 不能插队
    items = markOutboxRetry(items, "a", "offline", 10);
    expect(dueOutbox(items, 10).map((i) => i.id)).toEqual(["c"]);
    expect(dueOutbox(items, 10 + backoffMs(1)).map((i) => i.id)).toEqual(["a", "c"]);
    // a 送达后轮到 b
    items = removeOutbox(items, "a");
    expect(dueOutbox(items, 10_000).map((i) => i.id)).toEqual(["b", "c"]);
  });

  test("入队顺序以 createdAt 为准，与数组顺序无关", () => {
    const items = [item("late", "p1", 50), item("early", "p1", 5)];
    expect(dueOutbox(items, 100).map((i) => i.id)).toEqual(["early"]);
  });

  test("正在发 / 本页自己发着的（skip）不重复发，且挡住同 lane 后面的", () => {
    const items = [item("a", "p1", 1), item("b", "p1", 2)];
    expect(dueOutbox(items, 10, new Set(["a"]))).toEqual([]);
  });

  test("已失败待取走的不发、也不挡后面的", () => {
    let items = [item("a", "p1", 1), item("b", "p1", 2)];
    items = markOutboxFailed(items, "a", { message: "dialog", code: "dialog_open" });
    expect(dueOutbox(items, 10).map((i) => i.id)).toEqual(["b"]);
    expect(pendingOutboxCount(items)).toBe(1);
  });

  test("herdr 与 chat 同名 target 不同 lane", () => {
    const items = [item("a", "x", 1, "herdr"), item("b", "x", 2, "chat")];
    expect(dueOutbox(items, 10).map((i) => i.id)).toEqual(["a", "b"]);
    expect(outboxFor(items, "chat", "x").map((i) => i.id)).toEqual(["b"]);
  });

  test("同 id 不重复入队", () => {
    const items = enqueueOutbox([item("a")], item("a"));
    expect(items).toHaveLength(1);
  });

  test("网络恢复：退避中的立即可发，次数不清零", () => {
    let items = markOutboxRetry([item("a")], "a", "offline", 100);
    expect(dueOutbox(items, 101)).toEqual([]);
    items = wakeOutbox(items, 101);
    expect(dueOutbox(items, 101).map((i) => i.id)).toEqual(["a"]);
    expect(items[0].attempts).toBe(1);
  });
});

describe("Outbox 持久化", () => {
  test("序列化后读回来一模一样（刷新页面不丢）", () => {
    let items = [item("a", "p1", 1), item("b", "p2", 2, "chat")];
    items = markOutboxRetry(items, "a", "offline", 5);
    expect(parseOutbox(serializeOutbox(items), 10)).toEqual(items);
  });

  test("坏数据：整串坏返回空，单条坏丢那一条", () => {
    expect(parseOutbox("not json")).toEqual([]);
    expect(parseOutbox(JSON.stringify({ not: "array" }))).toEqual([]);
    const good = item("a");
    expect(parseOutbox(JSON.stringify([good, { id: 1 }, null]), 10)).toEqual([good]);
    expect(parseOutbox(null)).toEqual([]);
  });

  test("太久没发出去的标成失败，不再自动发", () => {
    const old = item("a", "p1", 0);
    const [parsed] = parseOutbox(serializeOutbox([old]), OUTBOX_MAX_AGE_MS + 1);
    expect(parsed.failed?.message).toContain("很久没发出去");
    expect(dueOutbox([parsed], OUTBOX_MAX_AGE_MS + 1)).toEqual([]);
  });
});

describe("失败分类与退避", () => {
  test("网络层 / 网关 / 限流可重发，其余不重发", () => {
    for (const status of [0, 408, 425, 429, 502, 503, 504]) expect(isRetriableStatus(status)).toBeTrue();
    for (const status of [400, 401, 403, 404, 409, 413, 500]) expect(isRetriableStatus(status)).toBeFalse();
  });

  test("指数退避，封顶 30 秒", () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(backoffMs)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });
});

describe("networkTitle", () => {
  const base = { online: true, streamConnected: true, streamEverConnected: true, pending: 0 };
  test("都好 → null", () => expect(networkTitle(base)).toBeNull());
  test("离线 → 等待网络", () => expect(networkTitle({ ...base, online: false, pending: 3 })).toBe("等待网络"));
  test("推送流断了（连上过）→ 连接中…", () =>
    expect(networkTitle({ ...base, streamConnected: false })).toBe("连接中…"));
  test("页面刚打开、推送流还没连上过 → 不提示", () =>
    expect(networkTitle({ ...base, streamConnected: false, streamEverConnected: false })).toBeNull());
  test("在线但还有消息等重发 → 连接中…", () => expect(networkTitle({ ...base, pending: 1 })).toBe("连接中…"));
});
