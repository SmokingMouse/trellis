import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const { HerdrPromptChangedError } = await import("./herdr-client");

// 路由拿的是 globalThis 上的 fleet 单例：换成假的，只看 /keys、/text 的 expectedRev 与 409 形状
const calls: unknown[][] = [];
const currentRev = "rev-now";
const fakeFleet = {
  ensureStarted: async () => {},
  keys: async (paneId: string, keys: string[], expectedRev?: string) => {
    calls.push(["keys", paneId, keys, expectedRev]);
    if (expectedRev !== undefined && expectedRev !== currentRev) throw new HerdrPromptChangedError(currentRev, null);
    return { type: "ok" };
  },
  text: async (paneId: string, text: string, submit: boolean, expectedRev?: string) => {
    calls.push(["text", paneId, text, submit, expectedRev]);
    if (expectedRev !== undefined && expectedRev !== currentRev) throw new HerdrPromptChangedError(currentRev, null);
    return { type: "ok" };
  },
};
(globalThis as { __trellisHerdrFleet?: unknown }).__trellisHerdrFleet = fakeFleet;

const keysRoute = await import("../../app/api/herdr/panes/[id]/keys/route");
const textRoute = await import("../../app/api/herdr/panes/[id]/text/route");

const params = { params: Promise.resolve({ id: "w1:p1" }) };
const post = (body: unknown) => new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) });

describe("POST /api/herdr/panes/:id/keys · expectedRev", () => {
  test("rev 对得上 → 200", async () => {
    const res = await keysRoute.POST(post({ keys: ["1"], expectedRev: "rev-now" }), params);
    expect(res.status).toBe(200);
  });

  test("rev 对不上 → 409 prompt_changed，带此刻的 rev，什么都没按", async () => {
    const res = await keysRoute.POST(post({ keys: ["1"], expectedRev: "rev-old" }), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "prompt_changed", delivered: "none", rev: "rev-now" });
  });

  test("不带 expectedRev 的旧调用照常工作", async () => {
    calls.length = 0;
    const res = await keysRoute.POST(post({ keys: ["Escape"] }), params);
    expect(res.status).toBe(200);
    expect(calls[0]).toEqual(["keys", "w1:p1", ["Escape"], undefined]);
  });

  test("expectedRev 不是字符串 → 400", async () => {
    const res = await keysRoute.POST(post({ keys: ["1"], expectedRev: 42 }), params);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/herdr/panes/:id/text · expectedRev", () => {
  test("rev 对不上 → 409 prompt_changed", async () => {
    const res = await textRoute.POST(post({ text: "answer", expectedRev: "rev-old" }), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "prompt_changed" });
  });

  test("不带 expectedRev 照常", async () => {
    const res = await textRoute.POST(post({ text: "answer" }), params);
    expect(res.status).toBe(200);
  });
});
