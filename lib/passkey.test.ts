import { describe, expect, test } from "bun:test";
import {
  ChallengeStore,
  FailureLimiter,
  challengeFromClientData,
  normalizeOrigin,
  parseAllowedOrigins,
  resolveRp,
} from "./passkey";

describe("normalizeOrigin", () => {
  test("规范化合法 origin", () => {
    expect(normalizeOrigin("https://trellis.smokingmouse.cc")).toBe("https://trellis.smokingmouse.cc");
    expect(normalizeOrigin("https://Trellis.SmokingMouse.cc/")).toBe("https://trellis.smokingmouse.cc");
    expect(normalizeOrigin("https://a.example:443")).toBe("https://a.example");
    expect(normalizeOrigin("http://localhost:3484")).toBe("http://localhost:3484");
  });
  test("拒绝非 origin 形态", () => {
    for (const bad of ["", "null", "not a url", "ftp://x.example", "https://x.example/path", "https://x.example?q=1", "https://u:p@x.example", "javascript:alert(1)"]) {
      expect(normalizeOrigin(bad)).toBeNull();
    }
  });
});

describe("parseAllowedOrigins", () => {
  test("未配置 → prod 域名 + 任意端口 localhost", () => {
    for (const raw of [undefined, "", "  "]) {
      const a = parseAllowedOrigins(raw);
      expect([...a.exact]).toEqual(["https://trellis.smokingmouse.cc"]);
      expect(a.anyLocalhost).toBe(true);
    }
  });
  test("显式配置覆盖默认；非法项丢弃", () => {
    const a = parseAllowedOrigins("https://a.example, nonsense ,https://b.example/");
    expect([...a.exact].sort()).toEqual(["https://a.example", "https://b.example"]);
    expect(a.anyLocalhost).toBe(false);
  });
  test("localhost 关键字", () => {
    expect(parseAllowedOrigins("localhost").anyLocalhost).toBe(true);
  });
});

describe("resolveRp", () => {
  const def = parseAllowedOrigins(undefined);
  test("prod origin → rpId = hostname", () => {
    expect(resolveRp("https://trellis.smokingmouse.cc", def)).toEqual({
      origin: "https://trellis.smokingmouse.cc",
      rpId: "trellis.smokingmouse.cc",
    });
  });
  test("localhost 任意端口", () => {
    expect(resolveRp("http://localhost:3484", def)).toEqual({ origin: "http://localhost:3484", rpId: "localhost" });
  });
  test("白名单外 / 子域 / http 降级 / IP / 缺失 → null", () => {
    expect(resolveRp("https://evil.example", def)).toBeNull();
    expect(resolveRp("https://x.trellis.smokingmouse.cc", def)).toBeNull();
    expect(resolveRp("http://trellis.smokingmouse.cc", def)).toBeNull();
    expect(resolveRp("http://127.0.0.1:3088", parseAllowedOrigins("http://127.0.0.1:3088"))).toBeNull();
    expect(resolveRp(null, def)).toBeNull();
    expect(resolveRp("null", def)).toBeNull();
  });
  test("关掉 localhost 后 localhost 被拒", () => {
    expect(resolveRp("http://localhost:3088", parseAllowedOrigins("https://trellis.smokingmouse.cc"))).toBeNull();
  });
  test("非 localhost 的 http 即使写进白名单也拒", () => {
    expect(resolveRp("http://mini.local:3088", parseAllowedOrigins("http://mini.local:3088"))).toBeNull();
  });
});

describe("ChallengeStore", () => {
  const rp = { origin: "http://localhost:1", rpId: "localhost" };
  test("一次性：consume 后再取为 null", () => {
    const s = new ChallengeStore(1000, 10, () => 0);
    s.issue("c1", "login", rp);
    expect(s.consume("c1", "login")).toEqual(rp);
    expect(s.consume("c1", "login")).toBeNull();
  });
  test("过期失效", () => {
    let t = 0;
    const s = new ChallengeStore(1000, 10, () => t);
    s.issue("c1", "login", rp);
    t = 1000;
    expect(s.consume("c1", "login")).toBeNull();
    s.issue("c2", "login", rp);
    t = 1999;
    expect(s.consume("c2", "login")).toEqual(rp);
  });
  test("kind 不符拒绝且已作废", () => {
    const s = new ChallengeStore(1000, 10, () => 0);
    s.issue("c1", "register", rp);
    expect(s.consume("c1", "login")).toBeNull();
    expect(s.consume("c1", "register")).toBeNull();
  });
  test("未知 challenge", () => {
    expect(new ChallengeStore(1000, 10).consume("nope", "login")).toBeNull();
  });
  test("容量封顶：先清过期，再挤最老", () => {
    let t = 0;
    const s = new ChallengeStore(100, 3, () => t);
    s.issue("a", "login", rp);
    s.issue("b", "login", rp);
    t = 50;
    s.issue("c", "login", rp);
    t = 120; // a、b 过期
    s.issue("d", "login", rp);
    expect(s.size).toBe(2);
    s.issue("e", "login", rp);
    s.issue("f", "login", rp); // 满了，挤掉最老的 c
    expect(s.size).toBe(3);
    expect(s.consume("c", "login")).toBeNull();
    expect(s.consume("f", "login")).toEqual(rp);
  });
});

describe("challengeFromClientData", () => {
  test("解出 challenge", () => {
    const b = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: "abc", origin: "x" })).toString("base64url");
    expect(challengeFromClientData(b)).toBe("abc");
  });
  test("坏输入 → null", () => {
    expect(challengeFromClientData(undefined)).toBeNull();
    expect(challengeFromClientData("")).toBeNull();
    expect(challengeFromClientData("!!!")).toBeNull();
    expect(challengeFromClientData(Buffer.from("{}").toString("base64url"))).toBeNull();
  });
});

describe("FailureLimiter", () => {
  test("per-key 达阈值后封到窗口结束；成功清零", () => {
    let t = 0;
    const l = new FailureLimiter({ windowMs: 1000, perKey: 3, global: 100 }, () => t);
    for (let i = 0; i < 3; i++) {
      expect(l.blockedFor("ip1")).toBe(0);
      l.recordFailure("ip1");
    }
    expect(l.blockedFor("ip1")).toBe(1000);
    expect(l.blockedFor("ip2")).toBe(0);
    t = 400;
    expect(l.blockedFor("ip1")).toBe(600);
    t = 1000;
    expect(l.blockedFor("ip1")).toBe(0);
    l.recordFailure("ip2");
    l.recordSuccess("ip2");
    l.recordFailure("ip2");
    l.recordFailure("ip2");
    expect(l.blockedFor("ip2")).toBe(0);
  });
  test("global 兜底：换 key 也被封", () => {
    const t = 0;
    const l = new FailureLimiter({ windowMs: 1000, perKey: 100, global: 5 }, () => t);
    for (let i = 0; i < 5; i++) l.recordFailure(`ip${i}`);
    expect(l.blockedFor("fresh")).toBeGreaterThan(0);
    l.recordSuccess("ip0");
    expect(l.blockedFor("fresh")).toBeGreaterThan(0);
  });
  test("key 表封顶不炸", () => {
    const l = new FailureLimiter({ windowMs: 1000, perKey: 2, global: 1e9, maxKeys: 10 }, () => 0);
    for (let i = 0; i < 100; i++) l.recordFailure(`k${i}`);
    expect(l.blockedFor("k99")).toBe(0);
  });
});
