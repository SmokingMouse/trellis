import { afterAll, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reconcilePending } from "../pending";

mock.module("server-only", () => ({}));
const dir = mkdtempSync(path.join(tmpdir(), "trellis-pending-"));
const previous = process.env.TRELLIS_DB_PATH;
process.env.TRELLIS_DB_PATH = path.join(dir, "data.db");
const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const { persistPendingInteraction, persistPendingInteractions, clearPendingInteraction, getNode } = await import("./repo");
const { pendingSnapshot } = await import("./pending");
const { subscribeCliSync } = await import("./cli-sync-events");
afterAll(() => {
  sqlite.resetDBForTests();
  if (previous === undefined) delete process.env.TRELLIS_DB_PATH; else process.env.TRELLIS_DB_PATH = previous;
  rmSync(dir, { recursive: true, force: true });
});

test("跨会话聚合 run-bus 与 AS 多请求，时间稳定、逐项撤卡且 SSE 广播", () => {
  const db = sqlite.getDB();
  for (const id of ["run", "bound", "adopted"]) {
    db.prepare("INSERT INTO sessions(id,title,root_node_id,created_at,updated_at) VALUES (?,?,?,1,1)").run(id, id, id);
    db.prepare("INSERT INTO nodes(id,session_id,question,status,created_at) VALUES (?,?,'fixture','streaming',1)").run(id, id);
  }
  let changes = 0;
  const off = subscribeCliSync({ onEvent: event => { if (event.type === "pending_changed") changes++; }, onClose() {} });
  const approval = { toolUseId: "approve", toolName: "Bash", input: { command: "echo safe", description: "检查工作区" } };
  const question = { toolUseId: "question", toolName: "AskUserQuestion", input: { questions: [{ question: "选择哪条路径？" }] } };
  persistPendingInteraction("run", approval);
  persistPendingInteractions("bound", [approval, question]);
  persistPendingInteractions("adopted", [question]);
  const first = pendingSnapshot();
  expect(first.items).toHaveLength(4);
  expect(first.items.filter(i => i.kind === "question")).toHaveLength(2);
  expect(first.items.find(i => i.nodeId === "run")?.summary).toBe("检查工作区");
  expect(first.items.every(i => i.createdAt > 1)).toBeTrue();
  persistPendingInteractions("bound", [approval, question]);
  expect(pendingSnapshot().items.map(i => i.createdAt)).toEqual(first.items.map(i => i.createdAt));
  clearPendingInteraction("bound", "wrong-id");
  expect(pendingSnapshot().items).toHaveLength(4);
  clearPendingInteraction("bound", "approve");
  expect(getNode("bound")?.pendingInteraction?.toolUseId).toBe("question");
  expect(pendingSnapshot().items).toHaveLength(3);
  clearPendingInteraction("adopted", "question");
  clearPendingInteraction("run");
  expect(pendingSnapshot().items).toHaveLength(1);
  expect(changes).toBe(6);
  off();
});

test("旧快照不能复活撤卡，重复项按节点与请求去重", () => {
  const item = pendingSnapshot().items[0];
  const current = reconcilePending({ revision: 0, items: [] }, { revision: 2, items: [item, item] });
  expect(current.items).toHaveLength(1);
  const cleared = reconcilePending(current, { revision: 3, items: [] });
  expect(reconcilePending(cleared, current)).toBe(cleared);
});
