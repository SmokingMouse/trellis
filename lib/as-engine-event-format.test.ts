import { expect, test } from "bun:test";
import { isDebugEngineEvent, relativeEngineEventTime, restoreEngineEvents, summarizeEngineEvent } from "./as-engine-event-format";

test("native sleep command and completed item summaries", () => {
  expect(summarizeEngineEvent("item/completed", { params: { item: { type: "commandExecution", command: "sleep 45 s" } } })).toBe("sleep 45 s");
  expect(summarizeEngineEvent("item/completed", { item: { type: "agentMessage", text: "huge response" } })).toBe("回复完成");
});
test("hook completion and lifecycle", () => {
  expect(summarizeEngineEvent("hook/completed", { params: { hookName: "postToolUse", durationMs: 12 } })).toBe("hook postToolUse 完成 · 12 ms");
  expect(summarizeEngineEvent("engine/exited", { code: 143 })).toBe("引擎退出 (143)");
  expect(summarizeEngineEvent("exited", { exitCode: 0 })).toBe("引擎退出 (0)");
});
test("unknown and malformed payloads have bounded readable fallbacks", () => {
  for (const payload of [null, {}, [], 42]) expect(summarizeEngineEvent("new/event", payload)).toBe("收到事件，展开查看详情");
  expect(summarizeEngineEvent("new/event", { message: "hello\nworld" })).toBe("hello world");
  expect(summarizeEngineEvent("warning", { message: "x".repeat(1000) }).length).toBeLessThan(170);
});
test("default keeps lifecycle, warnings, errors and permission changes", () => {
  for (const method of ["started", "exited", "restart", "systemError", "engine/started", "thread/engine/exited", "warning", "permission_auto_response", "thread/permission/changed", "readonly_denied"]) expect(isDebugEngineEvent(method, {})).toBe(false);
  for (const method of ["item/completed", "hook/started", "hook/completed", "turn/completed", "reasoning", "text/delta", "unknown"]) expect(isDebugEngineEvent(method, {})).toBe(true);
  expect(isDebugEngineEvent("hook/completed", { params: { error: "failed" } })).toBe(false);
});
test("legacy logs survive migration; malformed caches and the 100 row limit", () => {
  expect(restoreEngineEvents(['exited: {"code":143}'])).toEqual([{ method: "exited", payload: { code: 143 }, at: null }]);
  expect(restoreEngineEvents(null)).toEqual([]);
  expect(restoreEngineEvents([null, 1, {}])).toEqual([]);
  expect(restoreEngineEvents(Array(110).fill("debug: {}"))).toHaveLength(100);
  expect(relativeEngineEventTime(null, 10000)).toBe("时间未知");
  expect(relativeEngineEventTime(1000, 46000)).toBe("45 秒前");
});
