// Regression derived from review repro/rv_origin_takeover.test.ts.
import { afterAll, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
mock.module("server-only", () => ({}));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-takeover-"));
const previousDbPath = process.env.TRELLIS_DB_PATH;
process.env.TRELLIS_DB_PATH = path.join(dir, "test.db");
const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const { attachSession, detachSession } = await import("./cli-sync-watcher");
const { getSession } = await import("./repo");
const { hasAliveHerdrBinding, reconcileHerdrPane, markHerdrPaneClosed } = await import("./herdr-bindings");
const chat = await import("../../app/api/chat/route");
const resume = await import("../../app/api/nodes/[id]/cli-resume/route");
const { isHerdrSession } = await import("../herdr-ui");
const sid = "11111111-2222-4333-8444-555555555555";
const file = path.join(dir, `${sid}.jsonl`);
fs.writeFileSync(file, [
  { type: "user", uuid: "u1", parentUuid: null, sessionId: sid, cwd: dir, timestamp: "2026-09-07T01:00:00Z", message: { role: "user", content: "hello" } },
  { type: "assistant", uuid: "a1", parentUuid: "u1", sessionId: sid, cwd: dir, timestamp: "2026-09-07T01:00:05Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
].map(row => JSON.stringify(row)).join("\n") + "\n");

afterAll(() => {
  detachSession(sid);
  sqlite.resetDBForTests();
  if (previousDbPath === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = previousDbPath;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Herdr takes priority over both existing and subsequent CLI attaches", () => {
  attachSession(file);
  expect(getSession(sid)?.origin).toBe("cli-import");
  attachSession(file, "claude", { origin: "herdr" });
  expect(getSession(sid)?.origin).toBe("herdr");
  attachSession(file);
  expect(getSession(sid)?.origin).toBe("herdr");
});

test("alive bindings lock root, branch, retry, CLI resume and UI even with stale origin", async () => {
  sqlite.getDB().prepare("UPDATE sessions SET origin = 'cli-import' WHERE id = ?").run(sid);
  reconcileHerdrPane({
    pane_id: "test:p1", terminal_id: "test-term", workspace_id: "test", tab_id: "test:t1", focused: false,
    agent: "claude", agent_status: "working", revision: 1, cwd: dir,
    agent_session: { source: "claude", agent: "claude", kind: "id", value: sid },
  }, undefined, { home: dir });
  expect(hasAliveHerdrBinding(sid)).toBeTrue();
  const session = getSession(sid)!;
  expect(session.origin).toBe("cli-import");
  expect(session.herdrAlive).toBeTrue();
  expect(isHerdrSession(session)).toBeTrue();
  for (const body of [
    { kind: "root", sessionId: sid, question: "hello" },
    { kind: "branch", parentNodeId: session.rootNodeId, question: "branch" },
    { kind: "retry", nodeId: session.rootNodeId },
  ]) {
    expect((await chat.POST(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify(body) }))).status).toBe(409);
  }
  expect((await resume.GET(new Request("http://localhost/api/nodes/u1/cli-resume"), { params: Promise.resolve({ id: session.rootNodeId }) })).status).toBe(409);
  markHerdrPaneClosed("test:p1");
  expect(hasAliveHerdrBinding(sid)).toBeFalse();
  expect(getSession(sid)?.herdrAlive).toBeFalse();
});
