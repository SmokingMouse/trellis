import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

mock.module("server-only", () => ({}));

import type { HerdrPane, HerdrSnapshot } from "./herdr-types";

const {
  HerdrClient,
  HerdrUnavailableError,
  resolveHerdrSocketPath,
} = await import("./herdr-client");

type RequestEnvelope = {
  id: string;
  method: string;
  params: Record<string, unknown>;
};

const pane = (revision: number, status: HerdrPane["agent_status"] = "idle"): HerdrPane => ({
  pane_id: "w1:p1",
  terminal_id: "term-1",
  workspace_id: "w1",
  tab_id: "w1:t1",
  focused: true,
  agent: "claude",
  agent_status: status,
  cwd: "/tmp/project",
  revision,
});

const snapshot = (revision = 5, protocol = 19): HerdrSnapshot => ({
  version: "0.8.0",
  protocol,
  workspaces: [{ workspace_id: "w1", label: "project" }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1" }],
  panes: [pane(revision)],
  layouts: [],
  agents: [{ pane_id: "w1:p1", name: "worker", state_change_seq: 1 }],
});

class FakeHerdr {
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-herdr-"));
  readonly socketPath = path.join(this.dir, "herdr.sock");
  readonly requests: RequestEnvelope[] = [];
  connections = 0;
  subscribeConnections = 0;
  protocol = 19;
  snapshot = snapshot();
  waitDelayMs = 0;
  private subscribers = new Set<Bun.Socket<{ buffer: string }>>();
  private listener: Bun.UnixSocketListener<{ buffer: string }>;

  constructor() {
    this.listener = Bun.listen({
      unix: this.socketPath,
      data: { buffer: "" },
      socket: {
        open: () => {
          this.connections++;
        },
        data: (socket, chunk) => {
          socket.data.buffer += chunk.toString();
          const newline = socket.data.buffer.indexOf("\n");
          if (newline < 0) return;
          const line = socket.data.buffer.slice(0, newline);
          socket.data.buffer = socket.data.buffer.slice(newline + 1);
          const request = JSON.parse(line) as RequestEnvelope;
          this.requests.push(request);
          if (request.method === "events.subscribe") {
            this.subscribeConnections++;
            this.subscribers.add(socket);
            socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
            socket.write(
              `${JSON.stringify({
                event: "pane_updated",
                data: { type: "pane_updated", pane: pane(3, "working") },
              })}\n`,
            );
            return;
          }
          const send = () => {
            let result: Record<string, unknown>;
            if (request.method === "ping") {
              result = {
                type: "pong",
                version: "0.8.0",
                protocol: this.protocol,
                capabilities: {},
              };
            } else if (request.method === "session.snapshot") {
              result = { type: "session_snapshot", snapshot: this.snapshot };
            } else if (request.method === "pane.split") {
              result = { type: "pane_info", pane: pane(0) };
            } else {
              result = { type: "ok" };
            }
            socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
          };
          if (request.method === "agent.wait" && this.waitDelayMs) {
            setTimeout(send, this.waitDelayMs);
          } else {
            send();
          }
        },
        close: (socket) => {
          this.subscribers.delete(socket);
        },
      },
    });
  }

  emit(event: Record<string, unknown>): void {
    const line = `${JSON.stringify(event)}\n`;
    for (const socket of this.subscribers) socket.write(line);
  }

  disconnectSubscribers(): void {
    for (const socket of [...this.subscribers]) socket.end();
  }

  close(): void {
    this.listener.stop(true);
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

const clients: InstanceType<typeof HerdrClient>[] = [];
const servers: FakeHerdr[] = [];

function clientFor(server: FakeHerdr, extra: ConstructorParameters<typeof HerdrClient>[0] = {}) {
  const client = new HerdrClient({
    socketPath: server.socketPath,
    requestTimeoutMs: 500,
    coalesceMs: 10,
    snapshotIntervalMs: 60_000,
    silenceIntervalMs: 60_000,
    healthIntervalMs: 50,
    random: () => 0.5,
    ...extra,
  });
  clients.push(client);
  return client;
}

afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  for (const server of servers.splice(0)) server.close();
});

describe("HerdrClient", () => {
  test("resolves the documented three-level socket path", () => {
    expect(resolveHerdrSocketPath({ HERDR_SOCKET_PATH: "/tmp/direct.sock" })).toBe(
      "/tmp/direct.sock",
    );
    expect(resolveHerdrSocketPath({ XDG_CONFIG_HOME: "/tmp/xdg", HOME: "/tmp/home" })).toBe(
      "/tmp/xdg/herdr/herdr.sock",
    );
    expect(resolveHerdrSocketPath({ HOME: "/tmp/home" })).toBe(
      "/tmp/home/.config/herdr/herdr.sock",
    );
  });

  test("uses one NDJSON request per connection and always includes params", async () => {
    const server = new FakeHerdr();
    servers.push(server);
    const client = clientFor(server);
    await client.start();
    await client.request("pane.read", { pane_id: "w1:p1", source: "recent" });

    expect(server.requests.every((request) => typeof request.id === "string")).toBeTrue();
    expect(server.requests.every((request) => request.params !== undefined)).toBeTrue();
    expect(server.connections).toBe(server.requests.length);
    const subscriptions = server.requests.find(
      (request) => request.method === "events.subscribe",
    )?.params.subscriptions as { type: string }[];
    expect(subscriptions.some((item) => item.type === "pane.agent_status_changed")).toBeFalse();
    expect(subscriptions.some((item) => item.type === "pane.output_matched")).toBeFalse();
  });

  test("subscribes before snapshot, discards replay, de-duplicates revisions and coalesces", async () => {
    const server = new FakeHerdr();
    servers.push(server);
    const client = clientFor(server);
    const revisions: number[] = [];
    client.subscribe((change) => {
      if (change.kind === "pane") revisions.push(change.pane.revision);
    });
    await client.start();

    expect(server.requests.findIndex((r) => r.method === "events.subscribe")).toBeLessThan(
      server.requests.findIndex((r) => r.method === "session.snapshot"),
    );
    expect(client.state.panes[0].revision).toBe(5);

    server.emit({
      event: "pane_updated",
      data: { type: "pane_updated", pane: pane(6, "working") },
    });
    server.emit({
      event: "pane_updated",
      data: { type: "pane_updated", pane: pane(8, "done") },
    });
    server.emit({
      event: "pane_updated",
      data: { type: "pane_updated", pane: pane(7, "blocked") },
    });
    await Bun.sleep(40);

    expect(client.state.panes[0].revision).toBe(8);
    expect(client.state.panes[0].agent_status).toBe("done");
    expect(revisions).toEqual([8]);
  });

  test("reconnects the event stream and snapshots again", async () => {
    const server = new FakeHerdr();
    servers.push(server);
    const client = clientFor(server);
    await client.start();
    const before = server.requests.filter((r) => r.method === "session.snapshot").length;
    server.disconnectSubscribers();
    await Bun.sleep(400);
    expect(server.subscribeConnections).toBeGreaterThanOrEqual(2);
    expect(server.requests.filter((r) => r.method === "session.snapshot").length).toBeGreaterThan(
      before,
    );
  });

  test("resnapshots instead of applying an overflowing event queue", async () => {
    const server = new FakeHerdr();
    servers.push(server);
    const client = clientFor(server, { queueLimit: 1, coalesceMs: 20 });
    await client.start();
    const before = server.requests.filter((r) => r.method === "session.snapshot").length;
    server.emit({
      event: "pane_updated",
      data: { type: "pane_updated", pane: pane(6, "working") },
    });
    server.emit({
      event: "pane_updated",
      data: { type: "pane_updated", pane: pane(7, "done") },
    });
    await Bun.sleep(60);
    expect(server.requests.filter((r) => r.method === "session.snapshot").length).toBeGreaterThan(
      before,
    );
    expect(client.state.panes[0].revision).toBe(5);
  });

  test("protocol mismatch keeps reads but rejects writes", async () => {
    const server = new FakeHerdr();
    server.protocol = 20;
    server.snapshot = snapshot(5, 20);
    servers.push(server);
    const client = clientFor(server);
    await client.start();
    expect(client.state.readOnly).toBeTrue();
    await client.request("pane.read", { pane_id: "w1:p1", source: "recent" });
    expect(client.sendKeys("w1:p1", ["Enter"])).rejects.toBeInstanceOf(
      HerdrUnavailableError,
    );
  });

  test("serializes input per pane", async () => {
    const server = new FakeHerdr();
    server.waitDelayMs = 30;
    servers.push(server);
    const client = clientFor(server);
    await client.start();
    await Promise.all([
      client.enqueueInput("w1:p1", "first", 500),
      client.enqueueInput("w1:p1", "second", 500),
    ]);
    const methods = server.requests
      .filter((request) => ["pane.send_input", "agent.wait"].includes(request.method))
      .map((request) => `${request.method}:${request.params.text ?? ""}`);
    expect(methods).toEqual([
      "pane.send_input:first",
      "agent.wait:",
      "pane.send_input:second",
      "agent.wait:",
    ]);
  });

  test("fails subsequent calls quickly while Herdr is down", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-herdr-missing-"));
    const client = new HerdrClient({
      socketPath: path.join(dir, "missing.sock"),
      requestTimeoutMs: 50,
      healthIntervalMs: 60_000,
    });
    clients.push(client);
    await client.start();
    const started = performance.now();
    await expect(client.request("session.snapshot")).rejects.toBeInstanceOf(
      HerdrUnavailableError,
    );
    expect(performance.now() - started).toBeLessThan(200);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
