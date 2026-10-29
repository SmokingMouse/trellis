import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
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

const RULE = "─".repeat(40);
const claudeScreen = (box: string) => ["⏺ done", "", RULE, box, RULE, "  ⏵⏵ bypass permissions on"].join("\n");
const EMPTY_CLAUDE_SCREEN = claudeScreen("❯\u00a0\x1b[0m\x1b[7m \x1b[0m");
const DRAFT_CLAUDE_SCREEN = claudeScreen("❯\u00a0half typed\x1b[0m\x1b[7m \x1b[0m");
const TRUST_DIALOG_SCREEN = " Quick safety check: trust this folder?\n\n   No, exit\n ❯ Yes, I trust this folder\n\n Enter to confirm · Esc to cancel";

class FakeHerdr {
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-herdr-"));
  readonly socketPath = path.join(this.dir, "herdr.sock");
  readonly requests: RequestEnvelope[] = [];
  connections = 0;
  subscribeConnections = 0;
  protocol = 19;
  snapshot = snapshot();
  waitDelayMs = 0;
  waitFailures = 0;
  snapshotDelayMs = 0;
  /** pane.read 依次返回的屏幕；只剩一张时一直返回它。默认是 Claude 的空输入框（发前读屏放行）。 */
  screens: (string | null)[] = [EMPTY_CLAUDE_SCREEN];
  private timers = new Set<ReturnType<typeof setTimeout>>();
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
          const capturedSnapshot = structuredClone(this.snapshot);
          const send = () => {
            if (request.method === "agent.wait" && this.waitFailures > 0) {
              this.waitFailures--;
              socket.end(`${JSON.stringify({ id: request.id, error: { code: "wait_failed", message: "first wait failed" } })}\n`);
              return;
            }
            let result: Record<string, unknown>;
            if (request.method === "ping") {
              result = {
                type: "pong",
                version: "0.8.0",
                protocol: this.protocol,
                capabilities: {},
              };
            } else if (request.method === "session.snapshot") {
              result = { type: "session_snapshot", snapshot: capturedSnapshot };
            } else if (request.method === "pane.read") {
              const text = this.screens.length > 1 ? this.screens.shift()! : this.screens[0];
              if (text === null) {
                socket.end(`${JSON.stringify({ id: request.id, error: { code: "read_failed", message: "read failed" } })}\n`);
                return;
              }
              result = { type: "pane_read", read: { text } };
            } else if (request.method === "pane.split") {
              result = { type: "pane_info", pane: pane(0) };
            } else {
              result = { type: "ok" };
            }
            socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
          };
          const delay = request.method === "agent.wait" ? this.waitDelayMs : request.method === "session.snapshot" ? this.snapshotDelayMs : 0;
          if (delay) {
            const timer = setTimeout(() => { this.timers.delete(timer); send(); }, delay);
            this.timers.add(timer);
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
    for (const timer of this.timers) clearTimeout(timer);
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
  test("N1 ten known non-git workspace updates do not request extra snapshots", async () => {
    const server = new FakeHerdr();
    servers.push(server);
    const client = clientFor(server);
    await client.start();
    const initial = server.requests.filter(r => r.method === "session.snapshot").length;
    for (const event of ["workspace_updated", "workspace_metadata_updated", "workspace_created"]) {
      for (let i = 0; i < 10; i++) {
        const workspace = { workspace_id: "w1", label: `${event}-${i}` };
        server.snapshot.workspaces[0] = workspace;
        server.emit({ event, data: { workspace } });
        // Separate flushes: coalescing must not hide a snapshot storm.
        await Bun.sleep(30);
        expect(client.state.workspaces[0].label).toBe(workspace.label);
        expect(server.requests.filter(r => r.method === "session.snapshot")).toHaveLength(initial);
      }
    }
  });

  test("N1 new workspaces and changed explicit worktree metadata still resync", async () => {
    const server = new FakeHerdr();
    servers.push(server);
    const client = clientFor(server);
    await client.start();
    const count = () => server.requests.filter(r => r.method === "session.snapshot").length;
    for (const [index, event] of ["workspace_created", "workspace_updated", "workspace_metadata_updated"].entries()) {
      const workspace = { workspace_id: `new-${index}`, label: "New" };
      server.snapshot.workspaces.push(workspace);
      const before = count();
      server.emit({ event, data: { workspace } });
      await Bun.sleep(30);
      expect(count()).toBe(before + 1);
      expect(client.state.workspaces.some(w => w.workspace_id === workspace.workspace_id)).toBeTrue();
    }
    const worktree = { repo_root: "/repo", repo_name: "Repo", checkout_path: "/repo", is_linked_worktree: false };
    for (const incoming of [worktree, { ...worktree, checkout_path: "/linked", is_linked_worktree: true }, null]) {
      const workspace = { workspace_id: "w1", label: "Changed", worktree: incoming };
      server.snapshot.workspaces[0] = workspace;
      const before = count();
      server.emit({ event: "workspace_updated", data: { workspace } });
      await Bun.sleep(30);
      expect(count()).toBe(before + 1);
      expect(client.state.workspaces[0].worktree).toEqual(incoming);
      server.emit({ event: "workspace_metadata_updated", data: { workspace: structuredClone(workspace) } });
      await Bun.sleep(30);
      expect(count()).toBe(before + 1);
    }
  });
  test("a close flushed during snapshot RTT cannot be resurrected by its stale response", async () => {
    const server = new FakeHerdr();
    servers.push(server);
    const client = clientFor(server, { snapshotIntervalMs: 40 });
    await client.start();
    server.snapshotDelayMs = 90;
    const deadline = Date.now() + 500;
    while (server.requests.filter(r => r.method === "session.snapshot").length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(server.requests.filter(r => r.method === "session.snapshot").length).toBe(2);
    server.emit({ event: "pane_closed", data: { type: "pane_closed", pane_id: "w1:p1" } });
    server.snapshot.panes = [];
    server.snapshot.agents = [];
    await Bun.sleep(25);
    expect(client.state.panes).toHaveLength(0);
    const snapshots: number[] = [];
    client.subscribe(change => { if (change.kind === "snapshot") snapshots.push(client.state.panes.length); });
    await Bun.sleep(90);
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.every(count => count === 0)).toBeTrue();
    expect(client.state.panes).toHaveLength(0);
    expect(client.state.agents).toHaveLength(0);
  });

  test("Bun Unix errors distinguish permission denial and stop retrying (rv_err regression)", async () => {
    const server = new FakeHerdr();
    servers.push(server);
    fs.chmodSync(server.socketPath, 0o000);
    const client = clientFor(server, { healthIntervalMs: 10 });
    const connects = spyOn(Bun, "connect");
    try {
      await client.start();
      expect(client.state.available).toBeFalse();
      expect(client.state.lastError).toContain("EACCES");
      const attempts = connects.mock.calls.length;
      expect(attempts).toBe(1);
      await Bun.sleep(60);
      expect(connects.mock.calls).toHaveLength(attempts);
    } finally {
      connects.mockRestore();
      fs.chmodSync(server.socketPath, 0o600);
    }
  });

  test("a non-socket is reported distinctly from a missing endpoint", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-herdr-nonsocket-"));
    const file = path.join(dir, "not.sock");
    fs.writeFileSync(file, "");
    const client = new HerdrClient({ socketPath: file });
    clients.push(client);
    try {
      await expect(client.request("ping")).rejects.toMatchObject({ code: "ENOTSOCK" });
      await expect(new HerdrClient({ socketPath: path.join(dir, "missing.sock") }).request("ping")).rejects.toMatchObject({ code: "ENOENT" });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

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
    const generation = client.state.generation;
    server.disconnectSubscribers();
    await Bun.sleep(20);
    expect(client.state.generation).toBeGreaterThan(generation);
    expect(client.state.realtime).toBeFalse();
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

  test("does not resurrect a pane when update and close share one flush", async () => {
    const server = new FakeHerdr();
    servers.push(server);
    const client = clientFor(server, { coalesceMs: 20 });
    await client.start();
    server.emit({
      event: "pane_updated",
      data: { type: "pane_updated", pane: pane(6, "working") },
    });
    server.emit({
      event: "pane_closed",
      data: { type: "pane_closed", pane_id: "w1:p1", workspace_id: "w1" },
    });
    await Bun.sleep(50);
    expect(client.state.panes).toHaveLength(0);
  });

  test("protocol mismatch keeps reads but rejects writes", async () => {
    const server = new FakeHerdr();
    server.protocol = 99;
    server.snapshot = snapshot(5, 99);
    servers.push(server);
    const client = clientFor(server);
    await client.start();
    expect(client.state.readOnly).toBeTrue();
    await client.request("pane.read", { pane_id: "w1:p1", source: "recent" });
    expect(client.sendKeys("w1:p1", ["Enter"])).rejects.toBeInstanceOf(
      HerdrUnavailableError,
    );
    expect(client.sendText("w1:p1", "hi")).rejects.toBeInstanceOf(
      HerdrUnavailableError,
    );
  });

  test("protocol 22 is supported for reads and writes", async () => {
    const server = new FakeHerdr();
    server.protocol = 22;
    server.snapshot = snapshot(5, 22);
    servers.push(server);
    const client = clientFor(server);
    await client.start();
    expect(client.state.readOnly).toBeFalse();
    await client.request("pane.read", { pane_id: "w1:p1", source: "recent" });
    await expect(client.sendKeys("w1:p1", ["Enter"])).resolves.toBeDefined();
  });

  test("queued inputs have independent receipts when the first wait fails", async () => {
    const server = new FakeHerdr();
    server.snapshot.panes = [pane(5, "working")];
    server.waitDelayMs = 30;
    server.waitFailures = 1;
    servers.push(server);
    const client = clientFor(server);
    await client.start();
    const first = await client.enqueueInput("w1:p1", "first", 500);
    const second = await client.enqueueInput("w1:p1", "second", 500);
    expect(first.status).toBe("queued");
    expect(second.status).toBe("queued");
    expect(first.inputId).not.toBe(second.inputId);
    const deadline = Date.now() + 1000;
    while (client.inputDeliveries.some(input => input.status === "queued") && Date.now() < deadline) await Bun.sleep(10);
    expect(client.inputDeliveries.find(input => input.inputId === first.inputId)).toEqual({
      ...first, status: "failed", error: "first wait failed",
    });
    // 排队 / 失败回执带原文（刷新后恢复排队列表、失败放回输入框）；送达后原文清掉。
    expect(first.text).toBe("first");
    expect(typeof first.queuedAt).toBe("number");
    const secondWithoutText = { ...second };
    delete secondWithoutText.text;
    expect(client.inputDeliveries.find(input => input.inputId === second.inputId)).toEqual({
      ...secondWithoutText, status: "delivered",
    });
    expect(server.requests.filter(r => r.method === "pane.send_input").map(r => r.params.text)).toEqual(["second"]);
  });

  test("cancelled queued input is skipped; later inputs still deliver in order", async () => {
    const server = new FakeHerdr();
    server.snapshot.panes = [pane(5, "working")];
    server.waitDelayMs = 30;
    servers.push(server);
    const client = clientFor(server);
    await client.start();
    const first = await client.enqueueInput("w1:p1", "first", 500);
    const second = await client.enqueueInput("w1:p1", "second", 500);
    expect(client.cancelInput("w1:p2", first.inputId)).toBeFalse(); // 别的窗格
    expect(client.cancelInput("w1:p1", first.inputId)).toBeTrue();
    expect(client.cancelInput("w1:p1", first.inputId)).toBeFalse(); // 已不在排队
    expect(client.inputDeliveries.find(input => input.inputId === first.inputId)?.status).toBe("cancelled");
    const deadline = Date.now() + 1000;
    while (client.inputDeliveries.some(input => input.status === "queued") && Date.now() < deadline) await Bun.sleep(10);
    expect(client.inputDeliveries.find(input => input.inputId === first.inputId)?.status).toBe("cancelled");
    expect(client.inputDeliveries.find(input => input.inputId === second.inputId)?.status).toBe("delivered");
    expect(server.requests.filter(r => r.method === "pane.send_input").map(r => r.params.text)).toEqual(["second"]);
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
    await Bun.sleep(80);
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

  // Ported from review repro/rv_input_timeout.test.ts: production timeout,
  // with a wait that actually exceeds five seconds and isolated socket fixtures.
  test("acknowledges send immediately and queues behind a wait longer than five seconds", async () => {
    const server = new FakeHerdr();
    servers.push(server);
    server.waitDelayMs = 5_200;
    const client = clientFor(server, { requestTimeoutMs: undefined });
    await client.start();
    const started = performance.now();
    await client.enqueueInput("w1:p1", "first");
    expect(performance.now() - started).toBeLessThan(500);
    const second = client.enqueueInput("w1:p1", "second");
    await Bun.sleep(5_050);
    expect(server.requests.filter(r => r.method === "pane.send_input")).toHaveLength(1);
    expect(client.state.available).toBeTrue();
    expect(client.state.realtime).toBeTrue();
    expect((await second).status).toBe("queued");
    await Bun.sleep(200);
    expect(server.requests.filter(r => r.method === "pane.send_input").map(r => r.params.text)).toEqual(["first", "second"]);
  }, 10_000);

  test("busy panes wait beyond the ordinary RPC deadline before delivering", async () => {
    const server = new FakeHerdr();
    servers.push(server);
    server.snapshot.panes = [pane(5, "working")];
    server.waitDelayMs = 100;
    const client = clientFor(server, { requestTimeoutMs: 30 });
    await client.start();
    const started = performance.now();
    const receipt = await client.enqueueInput("w1:p1", "queued", 500);
    expect(receipt.status).toBe("queued");
    expect(performance.now() - started).toBeLessThan(50);
    expect(server.requests.filter(r => r.method === "pane.send_input")).toHaveLength(0);
    await Bun.sleep(130);
    expect(client.inputDeliveries.find(input => input.inputId === receipt.inputId)?.status).toBe("delivered");
    expect(server.requests.filter(r => ["pane.send_input", "agent.wait"].includes(r.method)).slice(0, 2).map(r => r.method)).toEqual(["agent.wait", "pane.send_input"]);
    expect(client.state.available).toBeTrue();
  });

  for (const change of ["closed", "reused", "stopped"] as const) {
    test(`R6 a queued input fails without sending when its target is ${change}`, async () => {
      const server = new FakeHerdr();
      servers.push(server);
      server.snapshot.panes = [pane(5, "working")];
      server.waitDelayMs = 100;
      const client = clientFor(server);
      await client.start();
      const receipt = await client.enqueueInput("w1:p1", "must not leak", 500);
      expect(receipt.status).toBe("queued");
      await Bun.sleep(10);
      if (change === "closed") server.emit({ event: "pane_closed", data: { type: "pane_closed", pane_id: "w1:p1" } });
      if (change === "reused") server.emit({ event: "pane_updated", data: { type: "pane_updated", pane: { ...pane(6, "idle"), terminal_id: "new-terminal" } } });
      if (change === "stopped") client.stop();
      await Bun.sleep(130);
      expect(client.inputDeliveries.find(input => input.inputId === receipt.inputId)?.status).toBe("failed");
      expect(server.requests.filter(r => r.method === "pane.send_input")).toHaveLength(0);
    });
  }

  describe("发前读屏核对", () => {
    const sent = (server: FakeHerdr) => server.requests.filter(r => r.method === "pane.send_input");
    const keys = (server: FakeHerdr) => server.requests.filter(r => r.method === "pane.send_keys").map(r => r.params.keys);

    test("空输入框：读一次带颜色的可见屏再发", async () => {
      const server = new FakeHerdr();
      servers.push(server);
      const client = clientFor(server);
      await client.start();
      expect((await client.enqueueInput("w1:p1", "hi", 500)).status).toBe("delivered");
      const read = server.requests.find(r => r.method === "pane.read");
      expect(read?.params).toMatchObject({ pane_id: "w1:p1", source: "visible", format: "ansi" });
      expect(server.requests.findIndex(r => r.method === "pane.read"))
        .toBeLessThan(server.requests.findIndex(r => r.method === "pane.send_input"));
    });

    for (const [name, screenText, code] of [
      ["信任目录对话框（herdr 报 idle）", TRUST_DIALOG_SCREEN, "dialog_open"],
      ["电脑上有草稿", DRAFT_CLAUDE_SCREEN, "input_draft"],
      ["读屏失败", null, "screen_unknown"],
    ] as const) {
      test(`${name} → 拒发，什么都没打`, async () => {
        const server = new FakeHerdr();
        server.screens = [screenText];
        servers.push(server);
        const client = clientFor(server);
        await client.start();
        await expect(client.enqueueInput("w1:p1", "hi", 500)).rejects.toMatchObject({ name: "HerdrSendRefusedError", code });
        expect(sent(server)).toHaveLength(0);
        expect(keys(server)).toHaveLength(0);
        const receipt = client.inputDeliveries.find(d => d.text === "hi");
        expect(receipt).toMatchObject({ status: "failed", refusal: { code } });
      });
    }

    test("草稿拒发带上原文和可清空的那段", async () => {
      const server = new FakeHerdr();
      server.screens = [DRAFT_CLAUDE_SCREEN];
      servers.push(server);
      const client = clientFor(server);
      await client.start();
      await expect(client.enqueueInput("w1:p1", "hi", 500)).rejects.toMatchObject({
        refusal: { code: "input_draft", draft: "half typed", clearable: "half typed" },
      });
    });

    test("clearDraft 与此刻草稿一致 → 清空、复核为空后再发", async () => {
      const server = new FakeHerdr();
      server.screens = [DRAFT_CLAUDE_SCREEN, EMPTY_CLAUDE_SCREEN];
      servers.push(server);
      const client = clientFor(server);
      await client.start();
      expect((await client.enqueueInput("w1:p1", "hi", 500, "half typed")).status).toBe("delivered");
      expect(keys(server)).toEqual([["ctrl+k", "ctrl+u"]]);
      expect(sent(server).map(r => r.params.text)).toEqual(["hi"]);
    });

    test("clearDraft 与此刻草稿不一致（电脑上又改了）→ 不清不发", async () => {
      const server = new FakeHerdr();
      server.screens = [DRAFT_CLAUDE_SCREEN];
      servers.push(server);
      const client = clientFor(server);
      await client.start();
      await expect(client.enqueueInput("w1:p1", "hi", 500, "something else")).rejects.toMatchObject({ code: "input_draft" });
      expect(keys(server)).toHaveLength(0);
      expect(sent(server)).toHaveLength(0);
    });

    test("清空后复核仍有字 → 拒发", async () => {
      const server = new FakeHerdr();
      server.screens = [DRAFT_CLAUDE_SCREEN, DRAFT_CLAUDE_SCREEN];
      servers.push(server);
      const client = clientFor(server);
      await client.start();
      await expect(client.enqueueInput("w1:p1", "hi", 500, "half typed")).rejects.toMatchObject({ code: "input_draft" });
      expect(keys(server)).toHaveLength(1);
      expect(sent(server)).toHaveLength(0);
    });

    test("排队的消息在送达那一刻才核对：等待期间电脑上开始打字 → 失败回执带 refusal", async () => {
      const server = new FakeHerdr();
      server.snapshot.panes = [pane(5, "working")];
      server.waitDelayMs = 30;
      server.screens = [DRAFT_CLAUDE_SCREEN];
      servers.push(server);
      const client = clientFor(server);
      await client.start();
      const receipt = await client.enqueueInput("w1:p1", "queued hi", 500);
      expect(receipt.status).toBe("queued");
      const deadline = Date.now() + 1000;
      while (client.inputDeliveries.some(d => d.status === "queued") && Date.now() < deadline) await Bun.sleep(10);
      expect(client.inputDeliveries.find(d => d.inputId === receipt.inputId)).toMatchObject({
        status: "failed", text: "queued hi", refusal: { code: "input_draft", draft: "half typed" },
      });
      expect(sent(server)).toHaveLength(0);
    });

    test("Codex 窗格只查对话框", async () => {
      const server = new FakeHerdr();
      server.snapshot.panes = [{ ...pane(5), agent: "codex" }];
      server.screens = ["› some codex text without a claude box"];
      servers.push(server);
      const client = clientFor(server);
      await client.start();
      expect((await client.enqueueInput("w1:p1", "hi", 500)).status).toBe("delivered");
    });
  });

  test("多字节字符被 socket 分块切开时不变成 U+FFFD", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-herdr-utf8-"));
    const socketPath = path.join(dir, "herdr.sock");
    const text = "─".repeat(50) + "你好";
    const listener = Bun.listen({
      unix: socketPath,
      socket: {
        data(socket, chunk) {
          const request = JSON.parse(chunk.toString().split("\n")[0]) as RequestEnvelope;
          const bytes = Buffer.from(`${JSON.stringify({ id: request.id, result: request.method === "ping"
            ? { type: "pong", version: "0.8.0", protocol: 19, capabilities: {} }
            : { type: "pane_read", read: { text } } })}\n`);
          // 在第一个「─」（3 字节）中间切开分两次写
          const cut = bytes.indexOf(Buffer.from("─")) + 1;
          socket.write(bytes.subarray(0, cut));
          setTimeout(() => socket.end(bytes.subarray(cut)), 5);
        },
      },
    });
    try {
      const client = new HerdrClient({ socketPath, requestTimeoutMs: 500 });
      clients.push(client);
      const result = await client.request<{ read: { text: string } }>("ping");
      expect(result).toMatchObject({ type: "pong" });
      // 绕开 available 门槛：直接测 ping 以外的读也走同一条解码路径
      const read = await (client as unknown as { requestWithRetry: (m: string, p: object, r: number, t: number) => Promise<{ read: { text: string } }> })
        .requestWithRetry("pane.read", {}, 0, 500);
      expect(read.read.text).toBe(text);
    } finally {
      listener.stop(true);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an RPC deadline preserves fleet availability and the event connection", async () => {
    const server = new FakeHerdr();
    servers.push(server);
    server.waitDelayMs = 100;
    const client = clientFor(server);
    await client.start();
    await expect(client.request("agent.wait", { target: "w1:p1" }, 10)).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(client.state.available).toBeTrue();
    expect(client.state.realtime).toBeTrue();
    await client.request("ping");
    expect(server.subscribeConnections).toBe(1);
  });

  test("fails subsequent calls quickly while Herdr is down", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-herdr-missing-"));
    const client = new HerdrClient({
      socketPath: path.join(dir, "missing.sock"),
      requestTimeoutMs: 50,
      healthIntervalMs: 60_000,
    });
    clients.push(client);
    const boot = performance.now();
    await client.start();
    expect(performance.now() - boot).toBeLessThan(200);
    const started = performance.now();
    await expect(client.request("session.snapshot")).rejects.toBeInstanceOf(
      HerdrUnavailableError,
    );
    expect(performance.now() - started).toBeLessThan(200);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("stale Unix sockets fail startup within 200ms (rv_degrade regression)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-herdr-stale-"));
    const original = path.join(dir, "live.sock");
    const stale = path.join(dir, "stale.sock");
    const listener = Bun.listen({ unix: original, socket: { data() {} } });
    fs.renameSync(original, stale);
    listener.stop(true);
    expect(fs.statSync(stale).isSocket()).toBeTrue();
    const client = new HerdrClient({ socketPath: stale });
    clients.push(client);
    try {
      const boot = performance.now();
      await client.start();
      expect(performance.now() - boot).toBeLessThan(200);
      expect(client.state.available).toBeFalse();
      await expect(client.request("pane.list")).rejects.toBeInstanceOf(HerdrUnavailableError);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
