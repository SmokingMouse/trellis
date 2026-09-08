import { expect, test } from "bun:test";
import type { AttachResult, Item } from "@smokingmouse/agent-server/protocol";
import { applyShadowEvent, emptyThreadLog } from "./as-log";

const item: Item = { id: "reply", seq: 3, turnId: "turn", startedAtMs: 1, status: "inProgress", type: "agentMessage", payload: { text: "one" } };
const snapshot = (items: Item[], nextSeq: number): AttachResult => ({
  thread: { id: "thread", backend: "codex", engineThreadId: null, status: { type: "running" }, cwd: "/tmp", createdAtMs: 0 },
  items, nextSeq, queue: [], pendingRequests: [],
});

test("P2-2 projects daemon errors and turn started/completed, deduplicating repeated frames", () => {
  const error = { type: "notification" as const, notification: { jsonrpc: "2.0" as const, method: "error" as const, params: { threadId: "thread", error: { code: -32015 as const, message: "engine protocol mismatch" }, willRetry: false } } };
  let log = applyShadowEvent(emptyThreadLog(), error);
  expect(log.errors[0].error.message).toBe("engine protocol mismatch");
  expect(applyShadowEvent(log, error)).toBe(log);
  const turn = { id: "turn", threadId: "thread", ordinal: 1, enqueuedAtMs: 0, status: "inProgress" as const };
  log = applyShadowEvent(log, { type: "notification", notification: { jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread", turnId: "turn", turn } } });
  expect(log.turns.turn.status).toBe("inProgress");
  const finished = { type: "notification" as const, notification: { jsonrpc: "2.0" as const, method: "turn/completed" as const, params: { threadId: "thread", turnId: "turn", turn: { ...turn, status: "completed" as const } } } };
  log = applyShadowEvent(log, finished);
  expect(log.turns.turn.status).toBe("completed");
  expect(applyShadowEvent(log, finished)).toBe(log);
});
test("partial snapshot replaces deltas; repeated snapshots and completion do not duplicate text", () => {
  let log = applyShadowEvent(emptyThreadLog(), { type: "snapshot", snapshot: snapshot([item], 4) });
  log = applyShadowEvent(log, { type: "notification", notification: { jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "turn", itemId: "reply", delta: " two" } } });
  expect(log.items.reply.payload).toEqual({ text: "one two" });
  const partial = { ...item, payload: { text: "one two three" } };
  for (let i = 0; i < 2; i++) log = applyShadowEvent(log, { type: "snapshot", snapshot: snapshot([partial], 4) });
  const completed = { ...partial, completedSeq: 4, status: "completed" as const, completedAtMs: 2 };
  for (let i = 0; i < 2; i++) log = applyShadowEvent(log, { type: "notification", notification: { jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread", turnId: "turn", itemId: "reply", item: completed, seq: 4, completedAtMs: 2 } } });
  expect(Object.keys(log.items)).toEqual(["reply"]);
  expect(log.items.reply.payload).toEqual({ text: "one two three" });
  expect(log.cursor).toBe(4);
  expect(applyShadowEvent(log, { type: "snapshot", snapshot: snapshot([completed], 5) })).toBe(log);
  expect(applyShadowEvent(log, { type: "connection", state: log.state })).toBe(log);
});
