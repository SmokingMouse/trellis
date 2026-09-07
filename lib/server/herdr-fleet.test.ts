import { afterEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

mock.module("server-only", () => ({}));

const { ensureHerdrSchema } = await import("./sqlite");
const { HerdrClient } = await import("./herdr-client");
const { HerdrFleetService } = await import("./herdr-fleet");
import type { HerdrPane } from "./herdr-types";

type RequestEnvelope = {
  id: string;
  method: string;
  params: Record<string, unknown>;
};

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function createHarness() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-herdr-fleet-"));
  const socketPath = path.join(home, "herdr.sock");
  const sessionId = "44444444-4444-4444-8444-444444444444";
  const cwd = "/tmp/fleet-project";
  const transcript = path.join(
    home,
    ".claude",
    "projects",
    "glob-can-find-this",
    `${sessionId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, `${JSON.stringify({ sessionId, cwd })}\n`);
  const basePane: HerdrPane = {
    pane_id: "w1:p1",
    terminal_id: "term-1",
    workspace_id: "w1",
    tab_id: "w1:t1",
    focused: true,
    agent: "claude",
    agent_session: {
      source: "herdr:claude",
      agent: "claude",
      kind: "id",
      value: sessionId,
    },
    agent_status: "idle",
    cwd,
    label: "worker",
    revision: 1,
  };
  const requests: RequestEnvelope[] = [];
  const snapshotPanes = [basePane];
  const subscribers = new Set<Bun.Socket<{ buffer: string }>>();
  const listener = Bun.listen({
    unix: socketPath,
    data: { buffer: "" },
    socket: {
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        const newline = socket.data.buffer.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(socket.data.buffer.slice(0, newline)) as RequestEnvelope;
        socket.data.buffer = socket.data.buffer.slice(newline + 1);
        requests.push(request);
        if (request.method === "events.subscribe") {
          subscribers.add(socket);
          socket.write(
            `${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`,
          );
          return;
        }
        let result: Record<string, unknown> = { type: "ok" };
        if (request.method === "ping") {
          result = { type: "pong", version: "0.8.0", protocol: 19 };
        } else if (request.method === "session.snapshot") {
          result = {
            type: "session_snapshot",
            snapshot: {
              version: "0.8.0",
              protocol: 19,
              workspaces: [{ workspace_id: "w1", label: "fleet" }],
              tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
              panes: snapshotPanes,
              layouts: [],
              agents: [{ pane_id: "w1:p1", name: "worker", state_change_seq: 10 }],
            },
          };
        } else if (request.method === "pane.split") {
          result = {
            type: "pane_info",
            pane: { ...basePane, pane_id: "w1:p2", terminal_id: "term-2", revision: 0 },
          };
        } else if (request.method === "pane.read") {
          // Wire shape captured by review rv_read_shape.ts / rv_readtext.ts.
          result = {
            type: "pane_read",
            read: {
              pane_id: basePane.pane_id, workspace_id: basePane.workspace_id, tab_id: basePane.tab_id,
              source: "recent", format: "text", revision: 1, truncated: false,
              text: Array.from({ length: 45 }, (_, index) => `line-${index + 1}`).join("\n"),
            },
          };
        }
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      },
      close(socket) {
        subscribers.delete(socket);
      },
    },
  });
  const emit = (event: Record<string, unknown>) => {
    for (const socket of subscribers) socket.write(`${JSON.stringify(event)}\n`);
  };
  const db = new Database(":memory:");
  ensureHerdrSchema(db);
  const attached: string[] = [];
  const client = new HerdrClient({
    socketPath,
    requestTimeoutMs: 500,
    coalesceMs: 10,
    snapshotIntervalMs: 60_000,
    silenceIntervalMs: 60_000,
    healthIntervalMs: 60_000,
  });
  const service = new HerdrFleetService(client, {
    db,
    home,
    attachClaude: (file) => attached.push(file),
  });
  cleanups.push(() => {
    service.stop();
    listener.stop(true);
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { service, client, requests, attached, transcript, sessionId, basePane, snapshotPanes, emit };
}

describe("HerdrFleetService", () => {
  test("builds workspace → tab → pane fleet and binds Claude once", async () => {
    const harness = createHarness();
    await harness.service.ensureStarted();
    const fleet = harness.service.fleet();
    expect(fleet.available).toBeTrue();
    expect(fleet.protocol).toBe(19);
    expect(fleet.workspaces).toHaveLength(1);
    const tabs = fleet.workspaces[0].tabs as Record<string, unknown>[];
    const panes = tabs[0].panes as Record<string, unknown>[];
    expect(panes[0]).toMatchObject({
      pane_id: "w1:p1",
      agent: "claude",
      agent_status: "idle",
      cwd: "/tmp/fleet-project",
      label: "worker",
    });
    expect(fleet.sessions[0]).toMatchObject({
      sessionId: harness.sessionId,
      paneId: "w1:p1",
      transcriptPath: harness.transcript,
      alive: true,
    });
    expect(harness.attached).toEqual([harness.transcript]);

    harness.emit({
      event: "pane_updated",
      data: {
        type: "pane_updated",
        pane: { ...harness.basePane, revision: 2, agent_status: "working" },
      },
    });
    await Bun.sleep(30);
    expect(harness.service.fleet().sessions[0].agentStatus).toBe("working");
    expect(harness.attached).toEqual([harness.transcript]);
  });

  test("ETag generation changes with an important fleet update", async () => {
    const harness = createHarness();
    await harness.service.ensureStarted();
    const before = harness.service.etag();
    harness.emit({
      event: "pane_updated",
      data: {
        type: "pane_updated",
        pane: { ...harness.basePane, revision: 2, label: "renamed" },
      },
    });
    await Bun.sleep(30);
    expect(harness.service.etag()).not.toBe(before);
  });

  test("reopens in the original workspace using split then atomic resume input", async () => {
    const harness = createHarness();
    await harness.service.ensureStarted();
    const paneId = await harness.service.reopen(harness.sessionId);
    expect(paneId).toBe("w1:p2");
    const split = harness.requests.find((request) => request.method === "pane.split")!;
    expect(split.params).toMatchObject({
      target_pane_id: "w1:p1",
      workspace_id: "w1",
      cwd: "/tmp/fleet-project",
      focus: false,
    });
    const input = harness.requests.find(
      (request) =>
        request.method === "pane.send_input" && request.params.pane_id === "w1:p2",
    )!;
    expect(input.params).toEqual({
      pane_id: "w1:p2",
      text: `claude --resume ${harness.sessionId}`,
      keys: ["Enter"],
    });
  });

  test("reopen prefers agent-free panes in the same workspace and never focuses them", async () => {
    const h = createHarness();
    h.snapshotPanes.push(
      { ...h.basePane, pane_id: "foreign", workspace_id: "w2", agent: null, agent_session: null },
      { ...h.basePane, pane_id: "idle", agent_status: "idle", agent_session: null },
      { ...h.basePane, pane_id: "empty", agent: null, agent_session: null },
    );
    h.basePane.agent_status = "working";
    await h.service.ensureStarted();
    await h.service.reopen(h.sessionId);
    expect(h.requests.find(r => r.method === "pane.split")?.params).toMatchObject({ target_pane_id: "empty", workspace_id: "w1", focus: false });
  });

  test("reopen uses done panes when no empty pane exists and refuses a busy workspace", async () => {
    const h = createHarness();
    h.basePane.agent_status = "working";
    h.snapshotPanes.push({ ...h.basePane, pane_id: "done", agent_status: "done", agent_session: null });
    await h.service.ensureStarted();
    await h.service.reopen(h.sessionId);
    expect(h.requests.find(r => r.method === "pane.split")?.params.target_pane_id).toBe("done");
    h.emit({ event: "pane_closed", data: { type: "pane_closed", pane_id: "done" } });
    await Bun.sleep(30);
    await expect(h.service.reopen(h.sessionId)).rejects.toThrow("no idle pane");
    expect(h.requests.filter(r => r.method === "pane.split")).toHaveLength(1);
  });

  test("HTTP input and keys reject shell panes, controls and oversized text before writing", async () => {
    const h = createHarness();
    h.snapshotPanes.push({ ...h.basePane, pane_id: "shell", agent: null, agent_session: null });
    const globals = globalThis as typeof globalThis & { __trellisHerdrFleet?: InstanceType<typeof HerdrFleetService> };
    globals.__trellisHerdrFleet = h.service;
    cleanups.push(() => { delete globals.__trellisHerdrFleet; });
    const input = await import("../../app/api/herdr/panes/[id]/input/route");
    const keys = await import("../../app/api/herdr/panes/[id]/keys/route");
    const request = (body: unknown) => new Request("http://localhost/api/herdr", { method: "POST", body: JSON.stringify(body) });
    for (const route of [input, keys]) {
      const body = route === input ? { text: "echo unsafe" } : { keys: ["Enter"] };
      expect((await route.POST(request(body), { params: Promise.resolve({ id: "shell" }) })).status).toBe(403);
      expect((await route.POST(request(body), { params: Promise.resolve({ id: "missing" }) })).status).toBe(404);
    }
    for (const [text, status] of [["中".repeat(12_000), 413], ["hi\u001b[201~", 400], ["hi\u0000", 400]] as const) {
      expect((await input.POST(request({ text }), { params: Promise.resolve({ id: "w1:p1" }) })).status).toBe(status);
    }
    expect(h.requests.filter(r => r.method === "pane.send_input" || r.method === "pane.send_keys")).toHaveLength(0);
    expect((await input.POST(request({ text: "hello\n\tworld" }), { params: Promise.resolve({ id: "w1:p1" }) })).status).toBe(200);
  });

  test("HTTP routes expose ETag polling, input, keys, and reopen", async () => {
    const harness = createHarness();
    const globals = globalThis as typeof globalThis & {
      __trellisHerdrFleet?: InstanceType<typeof HerdrFleetService>;
    };
    globals.__trellisHerdrFleet = harness.service;
    cleanups.push(() => {
      delete globals.__trellisHerdrFleet;
    });
    const fleetRoute = await import("../../app/api/herdr/fleet/route");
    const inputRoute = await import("../../app/api/herdr/panes/[id]/input/route");
    const keysRoute = await import("../../app/api/herdr/panes/[id]/keys/route");
    const readRoute = await import("../../app/api/herdr/panes/[id]/read/route");
    const reopenRoute = await import("../../app/api/herdr/sessions/[id]/reopen/route");

    const first = await fleetRoute.GET(new Request("http://trellis/api/herdr/fleet"));
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag")!;
    const unchanged = await fleetRoute.GET(
      new Request("http://trellis/api/herdr/fleet", {
        headers: { "If-None-Match": etag },
      }),
    );
    expect(unchanged.status).toBe(304);

    const input = await inputRoute.POST(
      new Request("http://trellis/api/herdr/panes/w1:p1/input", {
        method: "POST",
        body: JSON.stringify({ text: "hello" }),
      }),
      { params: Promise.resolve({ id: "w1:p1" }) },
    );
    expect(input.status).toBe(200);
    const sentInput = harness.requests.find(
      (request) => request.method === "pane.send_input" && request.params.text === "hello",
    );
    expect(sentInput?.params.keys).toEqual(["Enter"]);

    const keys = await keysRoute.POST(
      new Request("http://trellis/api/herdr/panes/w1:p1/keys", {
        method: "POST",
        body: JSON.stringify({ keys: ["1", "Enter"] }),
      }),
      { params: Promise.resolve({ id: "w1:p1" }) },
    );
    expect(keys.status).toBe(200);
    expect(
      harness.requests.find((request) => request.method === "pane.send_keys")?.params.keys,
    ).toEqual(["1", "Enter"]);

    const read = await readRoute.GET(
      new Request("http://trellis/api/herdr/panes/w1:p1/read"),
      { params: Promise.resolve({ id: "w1:p1" }) },
    );
    expect(read.status).toBe(200);
    const screen = (await read.json()) as { text: string };
    expect(screen.text.split("\n")).toHaveLength(40);
    expect(screen.text.startsWith("line-6\n")).toBeTrue();
    expect(
      harness.requests.find((request) => request.method === "pane.read")?.params,
    ).toEqual({ pane_id: "w1:p1", source: "recent", lines: 200 });

    const reopened = await reopenRoute.POST(
      new Request(`http://trellis/api/herdr/sessions/${harness.sessionId}/reopen`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: harness.sessionId }) },
    );
    expect(reopened.status).toBe(201);
    expect(await reopened.json()).toMatchObject({ ok: true, pane_id: "w1:p2" });
  });
});
