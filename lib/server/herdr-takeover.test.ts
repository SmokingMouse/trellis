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
const { getSession, listSessions } = await import("./repo");
const { hasAliveHerdrBinding, reconcileHerdrPane, markHerdrPaneClosed, listHerdrBindings } = await import("./herdr-bindings");
const chat = await import("../../app/api/chat/route");
const resume = await import("../../app/api/nodes/[id]/cli-resume/route");
const { isHerdrSession, findHerdrPaneForSession } = await import("../herdr-ui");
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
  expect(listSessions().some(session => session.id === sid)).toBeTrue();
  attachSession(file, "claude", { origin: "herdr" });
  expect(getSession(sid)?.origin).toBe("herdr");
  expect(listSessions().some(session => session.id === sid)).toBeTrue();
  attachSession(file);
  expect(getSession(sid)?.origin).toBe("herdr");
  expect((sqlite.getDB().prepare("SELECT kind FROM sessions WHERE id = ?").get(sid) as { kind: string }).kind).toBe("herdr");
  // Older mirrored rows are reclassified when the database opens, too.
  sqlite.getDB().prepare("UPDATE sessions SET kind = 'user' WHERE id = ?").run(sid);
  sqlite.resetDBForTests();
  expect(listSessions().some(session => session.id === sid)).toBeTrue();
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

test("P2-3 direct CLI resume API refuses every live owner regardless of origin", async () => {
  const session = getSession(sid)!;
  const request = () => resume.GET(new Request("http://localhost/api/nodes/direct/cli-resume"), { params: Promise.resolve({ id: session.rootNodeId }) });
  sqlite.getDB().prepare("UPDATE herdr_sessions SET alive = 1 WHERE session_id = ?").run(sid);
  for (const origin of ["native", "cli-import", "herdr"]) {
    sqlite.getDB().prepare("UPDATE sessions SET origin = ? WHERE id = ?").run(origin, sid);
    const response = await request();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ resumable: false });
  }
  markHerdrPaneClosed("test:p1");
  expect((await request()).status).toBe(200);
});

// review2 rv2_fork_gate: two JSONL files share turn UUIDs, but the pane owns
// the newer CLI sid while Trellis exposes the lineage root sid.
test("R1 lineage root locks chat and resolves the live pane and reopen", async () => {
  const root = "11111111-1111-4111-8111-111111111111";
  const fork = "22222222-2222-4222-8222-222222222222";
  const fixtureDir = path.join(dir, "lineage");
  fs.mkdirSync(fixtureDir);
  const rows = (sessionId: string) => [
    { type: "user", uuid: "shared-u", parentUuid: null, sessionId, cwd: fixtureDir, timestamp: "2026-09-07T01:00:00Z", message: { role: "user", content: "hello" } },
    { type: "assistant", uuid: "shared-a", parentUuid: "shared-u", sessionId, cwd: fixtureDir, timestamp: "2026-09-07T01:00:05Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
  ];
  fs.writeFileSync(path.join(fixtureDir, `${root}.jsonl`), rows(root).map(row => JSON.stringify(row)).join("\n") + "\n");
  await Bun.sleep(20);
  const forkFile = path.join(fixtureDir, `${fork}.jsonl`);
  fs.writeFileSync(forkFile, rows(fork).map(row => JSON.stringify(row)).join("\n") + "\n");
  attachSession(forkFile, "claude", { origin: "herdr" });
  try {
    expect(getSession(root)?.id).toBe(root);
    const pane = {
      pane_id: "fork:p1", terminal_id: "term", workspace_id: "fork", tab_id: "fork:t1", focused: false,
      agent: "claude", agent_status: "idle" as const, revision: 1, cwd: fixtureDir,
      agent_session: { source: "claude", agent: "claude", kind: "id" as const, value: fork },
    };
    reconcileHerdrPane(pane, undefined, { home: dir });
    expect(hasAliveHerdrBinding(root)).toBeTrue();
    expect(hasAliveHerdrBinding(fork)).toBeTrue();
    expect(getSession(root)?.herdrAlive).toBeTrue();
    const response = await chat.POST(new Request("http://localhost/api/chat", {
      method: "POST", body: JSON.stringify({ kind: "root", sessionId: root, question: "must not run" }),
    }));
    expect(response.status).toBe(409);
    const { HerdrFleetService } = await import("./herdr-fleet");
    const { HerdrClient } = await import("./herdr-client");
    const { spyOn } = await import("bun:test");
    const client = new HerdrClient();
    const start = spyOn(client, "start").mockResolvedValue();
    Object.defineProperty(client, "state", { value: { ...client.state, panes: [pane] } });
    const split = spyOn(client, "splitAndResume").mockResolvedValue("fork:p2");
    const service = new HerdrFleetService(client);
    const fleet = { ...service.fleet(), workspaces: [] };
    expect(isHerdrSession({ id: root }, fleet)).toBeTrue();
    expect(findHerdrPaneForSession(fleet, [], [], root)?.paneId).toBe("fork:p1");
    const globals = globalThis as typeof globalThis & { __trellisHerdrFleet?: InstanceType<typeof HerdrFleetService> };
    const previous = globals.__trellisHerdrFleet;
    globals.__trellisHerdrFleet = service;
    try {
      const reopen = await import("../../app/api/herdr/sessions/[id]/reopen/route");
      expect((await reopen.POST(new Request("http://localhost/reopen", { method: "POST" }), { params: Promise.resolve({ id: root }) })).status).toBe(201);
      expect(split.mock.calls[0]?.[1]).toBe(fork);
    } finally {
      globals.__trellisHerdrFleet = previous;
      service.stop();
      split.mockRestore();
      start.mockRestore();
    }
    markHerdrPaneClosed("fork:p1");
    expect(hasAliveHerdrBinding(root)).toBeFalse();
    expect(getSession(root)?.herdrAlive).toBeFalse();
    expect(listHerdrBindings().find(b => b.sessionId === fork)?.trellisSessionId).toBe(root);
  } finally { detachSession(root); }
});
