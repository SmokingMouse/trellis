import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentClient, MockEngine } from "@smokingmouse/agent-server";
import { runDaemon, resolveDaemonPaths, loadToken, type RunningDaemon } from "@smokingmouse/agent-server/daemon";
import type { AttachResult } from "@smokingmouse/agent-server/protocol";
import { ShadowClient, shadowRetryDelay } from "./as-client";
import { isShadowEnabled } from "../as-config";

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
  expect((await observer.connect()).sinceSeq(thread.id)).toBe(recovered.nextSeq - 1);
  const fresh = new ShadowClient({ socketPath: f.paths.socketPath, tokenPath: f.paths.tokenPath, warn: () => {} });
  cleanup.push(() => fresh.close());
  expect((await fresh.attach(thread.id, recovered.nextSeq - 1)).items).toEqual([]);
});

test("invalid cursors reject before connection", async () => {
  const observer = new ShadowClient();
  for (const cursor of [-1, 1.2, NaN, Infinity]) await expect(observer.attach("id", cursor)).rejects.toThrow("invalid sinceSeq");
  observer.close();
});

test("P1-2 observer is opt-in and backoff doubles from 1s to a 5 minute cap", () => {
  expect(isShadowEnabled({})).toBe(false);
  expect(isShadowEnabled({ TRELLIS_AS: "off" })).toBe(false);
  expect(isShadowEnabled({ TRELLIS_AS: "on" })).toBe(true);
  expect(isShadowEnabled({ TRELLIS_AS_SOCKET: "/tmp/test.sock" })).toBe(true);
  expect([0, 1, 2, 8, 9, 30].map(n => shadowRetryDelay(n))).toEqual([1000, 2000, 4000, 256000, 300000, 300000]);
});

test("P1-2 missing daemon reports once during exponential retries and once on recovery", async () => {
  const f = fixture(), warnings: string[] = [], recoveries: string[] = [];
  const observer = new ShadowClient({ socketPath: f.paths.socketPath, tokenPath: f.paths.tokenPath, retryMs: 20, warn: msg => warnings.push(msg), info: msg => recoveries.push(msg) });
  cleanup.push(() => observer.close());
  await expect(observer.connect()).rejects.toThrow();
  await Bun.sleep(200); // 20, 40, 80ms retries, all the same outage
  expect(warnings).toHaveLength(1);
  await f.start();
  await until(() => recoveries.length === 1);
  expect(warnings).toHaveLength(1);
  expect((await observer.listThreads()).threads).toEqual([]);
  expect(recoveries).toHaveLength(1);
});

test("P2-1 closed/unauthorized observer reloads token and reattaches without a page refresh", async () => {
  const f = fixture(); await f.start();
  const token = loadToken(f.paths.tokenPath), tokenPath = join(f.home, "observer-token");
  writeFileSync(tokenPath, token);
  const producer = await AgentClient.connectUnix({ path: f.paths.socketPath, token, reconnect: false });
  cleanup.push(() => producer.close());
  const { thread } = await producer.request("thread/start", { backend: "codex", cwd: f.home });
  const observer = new ShadowClient({ socketPath: f.paths.socketPath, tokenPath, retryMs: 20, warn: () => {}, info: () => {} });
  cleanup.push(() => observer.close());
  let snapshots = 0, closed = 0;
  observer.onEvent(event => {
    if (event.type === "snapshot") snapshots++;
    if (event.type === "connection" && event.state === "closed") closed++;
  });
  await observer.attach(thread.id);
  const original = await observer.connect();
  writeFileSync(tokenPath, "stale-token");
  original.close();
  await until(() => closed >= 2); // manual close, then server unauthorized
  writeFileSync(tokenPath, token);
  await until(() => snapshots >= 2);
  const rebuilt = await observer.connect();
  expect(rebuilt).not.toBe(original);
  expect(rebuilt.options.reconnect).toBe(false);
  expect(rebuilt.state).toBe("connected");
  let rebuiltPolls = 0;
  rebuilt.onSnapshot(() => rebuiltPolls++);
  await producer.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "poll after rebuild" }] });
  await Bun.sleep(2200);
  expect(rebuiltPolls).toBeGreaterThan(0);
});

test("P1-3 review 200KB/10s repro emits no redundant snapshots and idle stops polling", async () => {
  const f = fixture(); await f.start();
  const producer = await AgentClient.connectUnix({ path: f.paths.socketPath, token: loadToken(f.paths.tokenPath), reconnect: false });
  cleanup.push(() => producer.close());
  const { thread } = await producer.request("thread/start", { backend: "codex", cwd: f.home });
  const { turn } = await producer.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "long command" }] });
  f.engine.emit({ type: "itemStarted", turnId: turn.id, item: { id: "large", type: "commandExecution", payload: { command: "mock", cwd: f.home, aggregatedOutput: "x".repeat(200000) } } });
  await until(() => producer.sinceSeq(thread.id) >= 3);
  const observer = new ShadowClient({ socketPath: f.paths.socketPath, tokenPath: f.paths.tokenPath, warn: () => {} });
  cleanup.push(() => observer.close());
  let snapshots = 0, bytes = 0, idle = false;
  observer.onEvent(event => {
    if (event.type === "snapshot") { snapshots++; bytes += JSON.stringify(event).length; }
    if (event.type === "notification" && event.notification.method === "thread/status/changed" && event.notification.params.status.type === "idle") idle = true;
  });
  await observer.attach(thread.id);
  const firstBytes = bytes;
  const client = await observer.connect();
  let polls = 0;
  client.onSnapshot(() => polls++);
  await Bun.sleep(10100);
  expect(polls).toBeGreaterThanOrEqual(4);
  expect(snapshots).toBe(1);
  expect(bytes - firstBytes).toBe(0);
  f.engine.emit({ type: "turnCompleted", turnId: turn.id, status: "completed" });
  await until(() => idle);
  const idlePolls = polls;
  await Bun.sleep(2200);
  expect(polls).toBe(idlePolls);
}, 15000);

test("P2-1 review daemon kill/restart repro reconciles persisted items on the same socket", async () => {
  const home = mkdtempSync(join(tmpdir(), "as-restart-test-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const paths = resolveDaemonPaths({ NODE_ENV: "test", HOME: home, AGENT_SERVER_SOCKET_PATH: join(home, "as.sock") });
  const code = `
    import { MockEngine } from "@smokingmouse/agent-server";
    import { runDaemon } from "@smokingmouse/agent-server/daemon";
    const daemon = await runDaemon({graceMs:0, logger:()=>{}, serverOptions:{
      allowedRoots:[process.env.HOME], engineFactory:()=>new MockEngine(function*(turnId){
        yield {type:"itemStarted",turnId,item:{id:"persisted",type:"agentMessage",payload:{text:"before-kill"}}};
      },"codex")
    }});
    await Bun.write(process.env.AS_TEST_READY, "ready");
    await daemon.closed;
  `;
  const start = async (label: string) => {
    const ready = join(home, label);
    const process = Bun.spawn(["bun", "-e", code], { cwd: join(import.meta.dir, "../.."),
      env: { ...Bun.env, HOME: home, XDG_STATE_HOME: "", XDG_RUNTIME_DIR: "", AGENT_SERVER_SOCKET_PATH: paths.socketPath, AS_TEST_READY: ready },
      stdout: "pipe", stderr: "pipe" });
    cleanup.push(async () => { if (process.exitCode === null) process.kill(9); await process.exited; });
    await until(() => existsSync(ready));
    return process;
  };
  const first = await start("first-ready");
  const producer = await AgentClient.connectUnix({ path: paths.socketPath, token: loadToken(paths.tokenPath), reconnect: false });
  cleanup.push(() => producer.close());
  const { thread } = await producer.request("thread/start", { backend: "codex", cwd: home });
  await producer.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "persist" }] });
  await until(() => producer.sinceSeq(thread.id) >= 3);
  const observer = new ShadowClient({ socketPath: paths.socketPath, tokenPath: paths.tokenPath, retryMs: 20, warn: () => {}, info: () => {} });
  cleanup.push(() => observer.close());
  const snapshots: AttachResult[] = [];
  observer.onEvent(event => { if (event.type === "snapshot") snapshots.push(event.snapshot); });
  await observer.attach(thread.id);
  first.kill(9); await first.exited;
  await start("second-ready");
  await until(() => snapshots.length >= 2);
  const client = await observer.connect();
  const authoritative = await client.request("thread/attach", { threadId: thread.id, sinceSeq: 0 });
  const merged = new Map(snapshots.flatMap(snapshot => snapshot.items.map(item => [item.id, item] as const)));
  expect([...merged.values()]).toEqual(authoritative.items);
  expect(authoritative.items.find(item => item.id === "persisted")?.payload).toEqual({ text: "before-kill" });
  expect(client.sinceSeq(thread.id)).toBe(authoritative.nextSeq - 1);
  expect(authoritative.nextSeq - 1).toBeGreaterThan(3);
}, 8000);
