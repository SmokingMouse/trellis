import { mock } from "bun:test";
import type { ProjectRun } from "../../lib/server/as-project";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AgentClient, MockEngine, type MockScript } from "@smokingmouse/agent-server";
import { runDaemon, resolveDaemonPaths } from "@smokingmouse/agent-server/daemon";

mock.module("server-only", () => ({}));
const home = mkdtempSync("/tmp/trellis-as-regression-");
const paths = resolveDaemonPaths({ NODE_ENV: "test", HOME: home, AGENT_SERVER_SOCKET_PATH: join(home, "as.sock") });
Object.assign(process.env, { TRELLIS_DB_PATH: join(home, "test.db"), TRELLIS_AS: "on", TRELLIS_AS_PROJECT: "on", TRELLIS_AS_SOCKET: paths.socketPath, TRELLIS_AS_TOKEN_PATH: paths.tokenPath, TRELLIS_LARK: "off" });
const repo = await import("../../lib/server/repo");
const { getDB } = await import("../../lib/server/sqlite");
const as = await import("../../lib/server/as-project");
const binding = await import("../../lib/server/session-binding");
let pause: Promise<void> | undefined;
let fail = false;
const engines: MockEngine[] = [];
const script: MockScript = async function* (turnId) {
  yield { type: "itemStarted", turnId, item: { id: `${turnId}-answer`, type: "agentMessage", payload: { text: "" } } };
  if (pause) await pause;
  if (fail) { yield { type: "turnCompleted", turnId, status: "failed", error: { code: -32015, message: "mock retry failure" } }; return; }
  yield { type: "itemCompleted", turnId, item: { id: `${turnId}-answer`, type: "agentMessage", payload: { text: `answer ${turnId}` } } };
  yield { type: "turnCompleted", turnId, status: "completed" };
};
const daemon = await runDaemon({ paths, graceMs: 0, logger: () => {}, serverOptions: { allowedRoots: [home], backends: ["claude"], engineFactory: () => { const engine = new MockEngine(script, "claude"); engines.push(engine); return engine; } } });
const sid = randomUUID(), root = randomUUID();
repo.createSessionWithRoot({ sessionId: sid, nodeId: root, title: "probe", question: "root question", now: Date.now(), model: "mock", mode: "project", workspacePath: home, bindingType: "thread" });
function branch(parentId: string, question: string) {
  const nodeId = randomUUID();
  repo.createBranchNode({ parentId, nodeId, question, parentAnchor: null, now: Date.now() });
  return nodeId;
}
async function done(run: ProjectRun) {
  if (run.terminal) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("completion timeout")), 5000);
    run.subscribe({ onEvent: () => {}, onClose: () => { clearTimeout(timer); resolve(); } });
  });
}
async function start(nodeId: string, retry = false) {
  const run = await as.startProjectRun({ nodeId, prompt: repo.getNode(nodeId)!.question, attachments: [], retry });
  await done(run);
  return run;
}
function row(nodeId: string) { return getDB().prepare("SELECT response,status,tool_calls_json,token_input,token_output,final_start FROM nodes WHERE id=?").get(nodeId); }
try {
  await start(root);
  const second = branch(root, "second question");
  await start(second);
  if (process.argv[2] === "P1-1 non-tip continuation") {
    const earlier = branch(root, "earlier ordinary question");
    await start(earlier);
    assert.equal(repo.getNode(earlier)!.status, "done");
    assert.notEqual(binding.getAsTurn(earlier)!.thread_id, binding.getAsTurn(root)!.thread_id);
    const input = JSON.stringify(engines.at(-1)!.sent[0].input);
    assert.ok(input.includes("root question"));
    assert.ok(input.includes(repo.getNode(root)!.response));
    assert.ok(!input.includes("second question"));
  } else if (process.argv[2] === "P0-1 retry preserves answers") {
    const before = row(second), original = binding.getAsTurn(second)!.thread_id;
    let release!: () => void;
    pause = new Promise<void>(resolve => { release = resolve; });
    const run = await as.startProjectRun({ nodeId: second, prompt: "second question", attachments: [], retry: true });
    assert.deepEqual(row(second), before, "starting a retry must preserve the full answer");
    release(); pause = undefined;
    await done(run);
    assert.equal(repo.getNode(second)!.status, "done");
    assert.notEqual(binding.getAsTurn(second)!.thread_id, original, "tip retry uses a native tip fork");
    assert.notDeepEqual(row(second), before);
    fail = true;
    const saved = row(second), savedBinding = binding.getAsTurn(second);
    await start(second, true);
    assert.deepEqual(row(second), saved, "failed retry must retain old answer, tools, usage and status");
    assert.deepEqual(binding.getAsTurn(second), savedBinding);
    fail = false;
    await start(root, true);
    assert.equal(repo.getNode(root)!.status, "done", "non-tip retry seeds a new thread");
  } else if (process.argv[2] === "P1-2 hard off fallback") {
    const before = engines.reduce((n,e) => n + e.sent.length, 0);
    process.env.TRELLIS_AS = "off";
    assert.equal(binding.resolveSessionBinding(sid).type, "fallback");
    const { POST } = await import("../../app/api/chat/route");
    const response = await POST(new Request("http://localhost/api/chat", { method:"POST", body:JSON.stringify({kind:"branch", parentNodeId:second, question:"hard-off input preserved", provider:"mock"}) }));
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(text.includes('"type":"notice"'));
    assert.ok(text.includes('"type":"done"'));
    assert.equal(engines.reduce((n,e) => n + e.sent.length, 0), before, "hard-off must not start any AS turn");
    const node = getDB().prepare("SELECT id,question,status,response FROM nodes WHERE parent_id=? ORDER BY created_at DESC LIMIT 1").get(second) as {id:string;question:string;status:string;response:string};
    assert.equal(node.question, "hard-off input preserved");
    assert.equal(node.status, "done");
    assert.ok(node.response.length);
    assert.ok(!binding.getAsTurn(node.id));
  } else if (process.argv[2] === "P2-2 failed startup cleans bindings") {
    const before = getDB().prepare("SELECT * FROM as_threads ORDER BY thread_id").all();
    const originalStart = as.ProjectRun.prototype.start;
    as.ProjectRun.prototype.start = async () => { throw new as.DaemonUnavailable("mock failure after preflight"); };
    const { POST } = await import("../../app/api/chat/route");
    try {
      const response = await POST(new Request("http://localhost/api/chat", { method:"POST", body:JSON.stringify({kind:"branch", parentNodeId:root, question:"startup fallback", provider:"mock"}) }));
      assert.equal(response.status, 200);
      assert.ok((await response.text()).includes('"type":"notice"'));
      assert.deepEqual(getDB().prepare("SELECT * FROM as_threads ORDER BY thread_id").all(), before, "orphan fresh-thread row must be pruned");
      const node = getDB().prepare("SELECT id,status FROM nodes WHERE question='startup fallback'").get() as {id:string;status:string};
      assert.equal(node.status, "done");
      assert.ok(!binding.getAsTurn(node.id));
    } finally { as.ProjectRun.prototype.start = originalStart; }
  } else if (process.argv[2] === "P2-2 concurrent catchup shares initialization") {
    const pending = branch(second, "concurrent catchup");
    const threadId = binding.getAsTurn(second)!.thread_id;
    const params = { threadId, clientTurnId:randomUUID(), input:[{type:"text",text:"concurrent catchup"}] };
    binding.bindAsTurn(pending, threadId, params.clientTurnId);
    getDB().prepare("UPDATE as_turns SET request_json=? WHERE node_id=?").run(JSON.stringify(params), pending);
    let release!: () => void;
    pause = new Promise<void>(resolve => { release = resolve; });
    const originalConnect = AgentClient.prototype.connect;
    const clients = new Set<AgentClient>();
    AgentClient.prototype.connect = async function () { clients.add(this); await Bun.sleep(20); return originalConnect.call(this); };
    try {
      const [a,b] = await Promise.all([as.getProjectRun(pending), as.getProjectRun(pending)]);
      assert.ok(a);
      assert.equal(a,b);
      assert.equal(clients.size,1, "only one writable client initializes");
      assert.ok(a.turnId, "both callers await the initialized run");
      release(); pause = undefined;
      await done(a);
    } finally { AgentClient.prototype.connect = originalConnect; }
  } else throw new Error("unknown regression case");
  console.log(`PASS: ${process.argv[2]}`);
} finally {
  await daemon.shutdown();
  getDB().close();
  rmSync(home, { recursive: true, force: true });
}
process.exit(0);
