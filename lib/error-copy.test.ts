import { describe, expect, test } from "bun:test";
import { describeError, errorText } from "./error-copy";

describe("describeError", () => {
  test("network failures read as connectivity, raw kept", () => {
    const c = describeError(new TypeError("Failed to fetch"));
    expect(c.what).toBe("连不上 Trellis 服务");
    expect(c.raw).toBe("Failed to fetch");
  });
  test("status codes map to plain copy", () => {
    expect(describeError(new Error("HTTP 401")).what).toBe("登录已失效");
    expect(describeError("status: 404").what).toBe("要找的内容不存在");
    expect(describeError(new Error("HTTP 502 Bad Gateway")).what).toBe("服务端出错了");
  });
  test("abort / timeout", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    expect(describeError(e).what).toBe("请求超时了");
  });
  test("unknown errors fall back without losing the message", () => {
    const c = describeError({ message: "boom" });
    expect(c.what).toBe("操作没有完成");
    expect(c.raw).toBe("boom");
    expect(errorText(42)).toBe("42");
  });
});
