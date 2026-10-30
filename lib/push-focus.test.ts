import { describe, expect, test } from "bun:test";
import { herdrCardSelector, parsePushFocus, stripPushFocus } from "./push-focus";
import { buildHerdrPushPayload, buildPushPayload } from "./push";

describe("parsePushFocus", () => {
  test("与 lib/push.ts 构造的通知 url 一一对应", () => {
    const pending = new URL(buildPushPayload({ kind: "waiting", sessionId: "s1", nodeId: "n1" }).url, "https://x");
    expect(parsePushFocus(pending.search)).toEqual({ sessionId: "s1", nodeId: "n1", pendingNode: "n1", paneId: null, herdrView: false });
    const bound = new URL(buildHerdrPushPayload({ kind: "waiting", paneId: "w1:p1", sessionId: "s1", where: "x" }).url, "https://x");
    expect(parsePushFocus(bound.search)).toMatchObject({ sessionId: "s1", paneId: "w1:p1", herdrView: false });
    const loose = new URL(buildHerdrPushPayload({ kind: "waiting", paneId: "w1:p1", sessionId: null, where: "x" }).url, "https://x");
    expect(parsePushFocus(loose.search)).toMatchObject({ sessionId: null, paneId: "w1:p1", herdrView: true });
  });
  test("普通深链 / 完成通知没有定位参数 → null", () => {
    expect(parsePushFocus("?session=s1&node=n1")).toBeNull();
    expect(parsePushFocus("?focus=pending")).toBeNull();
    expect(parsePushFocus("")).toBeNull();
  });
  test("经 hub 改写的 /__gw/go/<机器>/... 302 落地后查询串原样，照样认", () => {
    const viaHub = new URL("/__gw/go/office/?session=s1&pane=w1%3Ap1", "https://hub.example");
    expect(parsePushFocus(viaHub.search)?.paneId).toBe("w1:p1");
  });
});

test("stripPushFocus 只抹定位参数，其余保留", () => {
  expect(stripPushFocus("https://x/?session=s1&node=n1&focus=pending")).toBe("/?session=s1&node=n1");
  expect(stripPushFocus("https://x/?view=herdr&pane=w1%3Ap1#a")).toBe("/?view=herdr#a");
});

test("herdrCardSelector 认总览卡与会话页卡，转义引号", () => {
  expect(herdrCardSelector("w1:p1")).toBe('[data-herdr-need-card="w1:p1"], [data-herdr-session-card="w1:p1"]');
  expect(herdrCardSelector('a"b')).toContain('a\\"b');
});
