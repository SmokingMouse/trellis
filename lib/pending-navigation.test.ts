import { expect, mock, test } from "bun:test";
import { openPendingItem } from "./pending-navigation";

test("先关闭 sheet，await store 跨会话导航，再滚动高亮目标卡片", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const store = { openNodeInSession: mock(async (sessionId: string, nodeId: string) => {
    calls.push(`navigate:${sessionId}:${nodeId}`);
    await new Promise<void>(resolve => { release = resolve; });
    calls.push("loaded");
  }) };
  const task = openPendingItem({ sessionId: "other", nodeId: "approval" },
    () => calls.push("close"), store, nodeId => calls.push(`reveal:${nodeId}`));
  expect(calls).toEqual(["close", "navigate:other:approval"]);
  expect(store.openNodeInSession).toHaveBeenCalledWith("other", "approval");
  release();
  await task;
  expect(calls).toEqual(["close", "navigate:other:approval", "loaded", "reveal:approval"]);
});

test("store 导航失败原样抛出，不滚动也不吞错", async () => {
  const failure = new Error("load failed");
  const reveal = mock(() => {});
  const close = mock(() => {});
  const store = { openNodeInSession: mock(async () => { throw failure; }) };
  await expect(openPendingItem({ sessionId: "s", nodeId: "n" }, close, store, reveal)).rejects.toBe(failure);
  expect(close).toHaveBeenCalledTimes(1);
  expect(reveal).not.toHaveBeenCalled();
});
