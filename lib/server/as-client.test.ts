import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentClient, MockEngine } from "@smokingmouse/agent-server";
import { runDaemon, resolveDaemonPaths, loadToken, type RunningDaemon } from "@smokingmouse/agent-server/daemon";
import type { AttachResult } from "@smokingmouse/agent-server/protocol";
import { ShadowClient } from "./as-client";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await Bun.sleep(10); }
  throw new Error("condition timeout");
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "as-shadow-test-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const paths = resolveDaemonPaths({ NODE_ENV: "test", HOME: home, AGENT_SERVER_SOCKET_PATH: join(home, "as.sock") });
  const engine = new MockEngine(undefined, "codex");
  let daemon: RunningDaemon;
  const start = async () => {
    daemon = await runDaemon({ paths, graceMs: 0, logger: () => {}, serverOptions: { engineFactory: () => engine, allowedRoots: [home] } });
    cleanup.push(() => daemon.shutdown());
    return daemon;
  };
  return { home, paths, engine, start };
}

test("initial daemon absence warns and reconnects without blocking boot", async () => {
  const f = fixture(), warnings: string[] = [];
  const observer = new ShadowClient({ socketPath: f.paths.socketPath, tokenPath: f.paths.tokenPath, retryMs: 20, warn: message => warnings.push(message) });
  cleanup.push(() => observer.close());
  let connected = false;
  observer.onEvent(event => { if (event.type === "connection" && event.state === "connected") connected = true; });
  await expect(observer.connect()).rejects.toThrow();
  await f.start();
  await until(() => connected);
  expect(warnings.length).toBeGreaterThan(0);
  expect((await observer.listThreads()).threads).toEqual([]);
});

test("socket loss reattaches with completed cursor and reconciles offline completion", async () => {
  const f = fixture(), daemon = await f.start();
  const producer = await AgentClient.connectUnix({ path: f.paths.socketPath, token: loadToken(f.paths.tokenPath), reconnect: false });
  cleanup.push(() => producer.close());
  const { thread } = await producer.request("thread/start", { backend: "codex", cwd: f.home });
  const observer = new ShadowClient({ socketPath: f.paths.socketPath, tokenPath: f.paths.tokenPath, retryMs: 80, warn: () => {} });
  cleanup.push(() => observer.close());
  const snapshots: AttachResult[] = [];
  observer.onEvent(event => { if (event.type === "snapshot") snapshots.push(event.snapshot); });
  const client = await observer.connect();
  await observer.attach(thread.id);
  const { turn } = await producer.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "test" }] });
  f.engine.emit({ type: "itemStarted", turnId: turn.id, item: { id: "answer", type: "agentMessage", payload: { text: "" } } });
  await until(() => client.sinceSeq(thread.id) >= 3);
  const cursor = client.sinceSeq(thread.id);
  daemon.manager.disconnect(client.clientId!);
  f.engine.emit({ type: "itemCompleted", turnId: turn.id, item: { id: "answer", type: "agentMessage", payload: { text: "offline complete" } } });
  await until(() => snapshots.length >= 2);
  const recovered = snapshots.at(-1)!;
  expect(recovered.items.map(item => item.id)).toEqual(["answer"]);
  expect(recovered.items[0].completedSeq).toBeGreaterThan(cursor);
  expect(recovered.items[0].payload).toEqual({ text: "offline complete" });
  expect(client.sinceSeq(thread.id)).toBe(recovered.nextSeq - 1);
  const fresh = new ShadowClient({ socketPath: f.paths.socketPath, tokenPath: f.paths.tokenPath, warn: () => {} });
  cleanup.push(() => fresh.close());
  expect((await fresh.attach(thread.id, recovered.nextSeq - 1)).items).toEqual([]);
});

test("invalid cursors reject before connection", async () => {
  const observer = new ShadowClient();
  for (const cursor of [-1, 1.2, NaN, Infinity]) await expect(observer.attach("id", cursor)).rejects.toThrow("invalid sinceSeq");
  observer.close();
});
