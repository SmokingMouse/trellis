import { afterEach, expect, test } from "bun:test";
import { fetchWithRetry, NavigationOwner } from "./client-navigation";
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

test("新导航取消旧所有者，旧 AbortError 不重试", async () => {
  const owner = new NavigationOwner();
  const first = owner.begin();
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    calls++;
    return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
  }) as typeof fetch;
  const request = fetchWithRetry("/first", 100, first.signal);
  const result = request.catch(error => error);
  const next = owner.begin();
  expect((await result).name).toBe("AbortError");
  expect(calls).toBe(1);
  expect(first.current()).toBeFalse();
  expect(next.current()).toBeTrue();
});

test("真正超时仅重试一次；第二次成功可返回，否则报 TimeoutError", async () => {
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    if (++calls === 2) return Response.json({ok:true});
    return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
  }) as typeof fetch;
  expect((await fetchWithRetry("/retry", 2)).ok).toBeTrue();
  expect(calls).toBe(2);
  calls = 0;
  globalThis.fetch = (async (_url, init) => {
    calls++;
    return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
  }) as typeof fetch;
  await expect(fetchWithRetry("/timeout", 2)).rejects.toHaveProperty("name", "TimeoutError");
  expect(calls).toBe(2);
});
