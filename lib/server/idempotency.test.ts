import { describe, expect, test } from "bun:test";
import { IdempotencyCache, isClientMsgId } from "./idempotency";

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("IdempotencyCache", () => {
  test("TTL 内同一个 key 只执行一次，重复请求拿到第一次的结果", async () => {
    const c = clock();
    const cache = new IdempotencyCache<number>(10_000, c.now);
    let calls = 0;
    const fn = async () => ++calls;
    expect(await cache.run("a", fn)).toBe(1);
    c.advance(9_999);
    expect(await cache.run("a", fn)).toBe(1);
    expect(calls).toBe(1);
  });

  test("过了 TTL 重新执行", async () => {
    const c = clock();
    const cache = new IdempotencyCache<number>(10_000, c.now);
    let calls = 0;
    await cache.run("a", async () => ++calls);
    c.advance(10_000);
    expect(await cache.run("a", async () => ++calls)).toBe(2);
    expect(cache.peek("a")).toBeDefined();
  });

  test("并发的重复请求等同一个 promise", async () => {
    const cache = new IdempotencyCache<string>();
    let release!: (value: string) => void;
    let calls = 0;
    const fn = () => {
      calls++;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };
    const first = cache.run("k", fn);
    const second = cache.run("k", fn);
    release("done");
    expect(await Promise.all([first, second])).toEqual(["done", "done"]);
    expect(calls).toBe(1);
  });

  test("第一次失败且什么都没发生（forgetOnError）→ 忘掉，重发真的再试", async () => {
    const cache = new IdempotencyCache<string>();
    const nothingSent = (error: unknown) => (error as Error).message === "refused";
    await expect(cache.run("k", async () => { throw new Error("refused"); }, nothingSent)).rejects.toThrow("refused");
    await Promise.resolve();
    expect(await cache.run("k", async () => "ok", nothingSent)).toBe("ok");
  });

  test("其余失败在 TTL 内回同一个错（可能已经打了一半，不能再打）", async () => {
    const cache = new IdempotencyCache<string>();
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error("timeout");
    };
    await expect(cache.run("k", fn)).rejects.toThrow("timeout");
    await expect(cache.run("k", fn)).rejects.toThrow("timeout");
    expect(calls).toBe(1);
  });

  test("超过上限从最早的丢", async () => {
    const cache = new IdempotencyCache<number>(60_000, Date.now, 3);
    for (const key of ["a", "b", "c", "d"]) await cache.run(key, async () => 1);
    expect(cache.peek("a")).toBeUndefined();
    expect(cache.peek("d")).toBeDefined();
    expect(cache.size).toBeLessThanOrEqual(3);
  });
});

test("isClientMsgId", () => {
  expect(isClientMsgId("2f1c9a3e-1111-4abc-9def-000000000000")).toBeTrue();
  expect(isClientMsgId("lq2x-abc123")).toBeTrue();
  expect(isClientMsgId("")).toBeFalse();
  expect(isClientMsgId("x".repeat(65))).toBeFalse();
  expect(isClientMsgId("has space")).toBeFalse();
  expect(isClientMsgId(42)).toBeFalse();
});
