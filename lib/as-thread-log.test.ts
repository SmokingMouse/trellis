import { expect, test } from "bun:test";
import type { AttachResult, Item } from "@smokingmouse/agent-server/protocol";
import { applyThreadEvent, emptyThreadLog } from "./as-thread-log";

const item: Item = { id: "reply", seq: 3, turnId: "turn", startedAtMs: 1, status: "inProgress", type: "agentMessage", payload: { text: "one" } };
const snapshot = (items: Item[], nextSeq: number): AttachResult => ({
  thread: { id: "thread", backend: "codex", engineThreadId: null, status: { type: "running" }, cwd: "/tmp", createdAtMs: 0 },
  items, nextSeq, queue: [], pendingRequests: [],
});

test("pending notifications add, deduplicate and withdraw read-only approvals without snapshots", () => {
  const params = {threadId:"thread",turnId:"turn",requestId:"approval",itemId:"command",kind:"commandExecution" as const,status:"pending" as const,decidedBy:null,createdAtMs:1,updatedAtMs:1};
  const event = {type:"notification" as const,notification:{jsonrpc:"2.0" as const,method:"thread/pendingRequests" as const,params}};
  const pending = applyThreadEvent(emptyThreadLog(),event);
  expect(pending.pending).toEqual([params]);
  expect(applyThreadEvent(pending,event)).toBe(pending);
  for (const status of ["resolved","expired"] as const) {
    const terminal = {...event,notification:{...event.notification,params:{...params,status,updatedAtMs:2}}};
    const cleared = applyThreadEvent(pending,terminal);
    expect(cleared.pending).toEqual([]);
    expect(applyThreadEvent(cleared,terminal)).toBe(cleared);
  }
});

test("P2-2 projects daemon errors and turn started/completed, deduplicating repeated frames", () => {
  const error = { type: "notification" as const, notification: { jsonrpc: "2.0" as const, method: "error" as const, params: { threadId: "thread", error: { code: -32015 as const, message: "engine protocol mismatch" }, willRetry: false } } };
  let log = applyThreadEvent(emptyThreadLog(), error);
  expect(log.errors[0].error.message).toBe("engine protocol mismatch");
  expect(applyThreadEvent(log, error)).toBe(log);
  const turn = { id: "turn", threadId: "thread", ordinal: 1, enqueuedAtMs: 0, status: "inProgress" as const };
  log = applyThreadEvent(log, { type: "notification", notification: { jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread", turnId: "turn", turn } } });
  expect(log.turns.turn.status).toBe("inProgress");
  const finished = { type: "notification" as const, notification: { jsonrpc: "2.0" as const, method: "turn/completed" as const, params: { threadId: "thread", turnId: "turn", turn: { ...turn, status: "completed" as const } } } };
  log = applyThreadEvent(log, finished);
  expect(log.turns.turn.status).toBe("completed");
  expect(applyThreadEvent(log, finished)).toBe(log);
});
test("partial snapshot replaces deltas; repeated snapshots and completion do not duplicate text", () => {
  let log = applyThreadEvent(emptyThreadLog(), { type: "snapshot", snapshot: snapshot([item], 4) });
  log = applyThreadEvent(log, { type: "notification", notification: { jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "turn", itemId: "reply", delta: " two" } } });
  expect(log.items.reply.payload).toEqual({ text: "one two" });
  const partial = { ...item, payload: { text: "one two three" } };
  for (let i = 0; i < 2; i++) log = applyThreadEvent(log, { type: "snapshot", snapshot: snapshot([partial], 4) });
  const completed = { ...partial, completedSeq: 4, status: "completed" as const, completedAtMs: 2 };
  for (let i = 0; i < 2; i++) log = applyThreadEvent(log, { type: "notification", notification: { jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread", turnId: "turn", itemId: "reply", item: completed, seq: 4, completedAtMs: 2 } } });
  expect(Object.keys(log.items)).toEqual(["reply"]);
  expect(log.items.reply.payload).toEqual({ text: "one two three" });
  expect(log.cursor).toBe(4);
  expect(applyThreadEvent(log, { type: "snapshot", snapshot: snapshot([completed], 5) })).toBe(log);
  expect(applyThreadEvent(log, { type: "connection", state: log.state })).toBe(log);
});
