import { describe, expect, it } from "bun:test";
import { isConnectivityFailure, readCachedSession, touchRecent } from "./offline-cache";

describe("touchRecent", () => {
  it("把会话提到最前并去重", () => {
    expect(touchRecent(["a", "b", "c"], "b").next).toEqual(["b", "a", "c"]);
    expect(touchRecent([], "a")).toEqual({ next: ["a"], evicted: [] });
  });

  it("超出上限的最旧会话被挤出", () => {
    expect(touchRecent(["a", "b", "c"], "d", 3)).toEqual({ next: ["d", "a", "b"], evicted: ["c"] });
    // 已在列表里的会话重新打开不挤人
    expect(touchRecent(["a", "b", "c"], "c", 3)).toEqual({ next: ["c", "a", "b"], evicted: [] });
  });
});

describe("isConnectivityFailure", () => {
  it("断网 / 超时（fetch 抛错）算连不上", () => {
    expect(isConnectivityFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isConnectivityFailure(new DOMException("请求超时", "TimeoutError"))).toBe(true);
  });

  it("5xx（隧道 / 网关）算连不上，4xx 是服务端的明确回答", () => {
    expect(isConnectivityFailure({ status: 502 })).toBe(true);
    expect(isConnectivityFailure({ status: 530 })).toBe(true);
    expect(isConnectivityFailure({ status: 404 })).toBe(false);
    expect(isConnectivityFailure({ status: 401 })).toBe(false);
  });

  it("主动取消不算", () => {
    expect(isConnectivityFailure(new DOMException("Navigation superseded", "AbortError"))).toBe(false);
  });
});

describe("IndexedDB 不可用", () => {
  it("读缓存静默返回 null，不抛错", async () => {
    expect(await readCachedSession("x")).toBeNull();
  });
});
