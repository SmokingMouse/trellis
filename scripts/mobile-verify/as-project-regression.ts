import { mock } from "bun:test";
import type { ProjectRun } from "../../lib/server/as-project";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AgentClient, MockEngine, type MockScript } from "@smokingmouse/agent-server";
import { runDaemon, resolveDaemonPaths, loadToken } from "@smokingmouse/agent-server/daemon";
import { omitMidThreadFork } from "./as-capability-mock";

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
  yield { type: "itemStarted", turnId, item: { id: `${turnId}-answer`, type: "agentMessage", payload: { text: pause && process.argv[2] === "idle SSE" ? "x".repeat(200000) : "" } } };
  if (pause) await pause;
  if (fail) { yield { type: "turnCompleted", turnId, status: "failed", error: { code: -32015, message: "mock retry failure" } }; return; }
  yield { type: "itemCompleted", turnId, item: { id: `${turnId}-answer`, type: "agentMessage", payload: { text: `answer ${turnId}` } } };
  yield { type: "turnCompleted", turnId, status: "completed", forkPoint: `checkpoint-${turnId}` };
};
const daemon = await runDaemon({ paths, graceMs: 0, logger: () => {}, serverOptions: { defaultModel: "sonnet", allowedRoots: [home], backends: ["claude"], engineFactory: () => { const engine = new MockEngine(script, "claude"); engines.push(engine); return engine; } } });
const oldDaemon = process.argv[2] === "fork capability fallback";
if (oldDaemon) omitMidThreadFork(daemon.server);
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
  if (process.argv[2] === "single project rollout") {
    const project = getDB().prepare("SELECT w.project_id FROM sessions s JOIN workspaces w ON w.id=s.workspace_id WHERE s.id=?").get(sid) as {project_id:string};
    const create = (workspacePath: string | null) => {
      const id = randomUUID();
      return repo.createSessionWithRoot({sessionId:id,nodeId:randomUUID(),title:"rollout",question:"do not run",now:Date.now(),mode:"project",workspacePath,bindingType:"thread"}).session;
    };
    process.env.TRELLIS_AS_PROJECT_ID = "another-project";
    assert.equal(create(home).bindingType, "legacy");
    process.env.TRELLIS_AS_PROJECT_ID = project.project_id;
    assert.equal(create(home).bindingType, "thread");
    assert.equal(create(null).bindingType, "legacy");
    assert.equal(repo.getSession(sid)!.bindingType, "thread");
    delete process.env.TRELLIS_AS_PROJECT_ID;
    assert.equal(create(home).bindingType, "thread");
    console.log("PASS: exact project rollout, unknown ownership fails closed, existing bindings unchanged, unset preserves compatibility");
  }
  await start(root);
  const second = branch(root, "second question");
  await start(second);
  if (process.argv[2] === "idle SSE") {
    let release!: () => void;
    pause = new Promise<void>(resolve => { release = resolve; });
    const pending = branch(second, "quiet large response");
    const run = await as.startProjectRun({nodeId:pending,prompt:"quiet large response",attachments:[]});
    const controller = new AbortController();
    const { GET } = await import("../../app/api/as/threads/[id]/stream/route");
    const responses = [as.projectSSE(new Request("http://localhost/stream",{signal:controller.signal}),run),
      await GET(new Request("http://localhost/stream",{signal:controller.signal}),{params:Promise.resolve({id:run.threadId})})];
    const bytes = [0,0];
    const readers = responses.map(r=>r.body!.getReader());
    const pumps = readers.map(async(reader,index)=>{while(true){const {done,value}=await reader.read();if(done)return;bytes[index]+=value.byteLength;}});
    await Bun.sleep(100);
    const initial = [...bytes];
    let attaches = 0;
    const request = AgentClient.prototype.request;
    AgentClient.prototype.request = function(method, params) { if(method === "thread/attach") attaches++; return request.call(this,method,params) as never; };
    try {
      await Bun.sleep(10100);
      const proof = {windowMs:10100,initialBytes:initial,projectBytes:bytes[0]-initial[0],shadowBytes:bytes[1]-initial[1],attaches};
      console.log(JSON.stringify(proof));
      if (!process.argv.includes("--baseline")) {
        assert.equal(proof.projectBytes,0); assert.equal(proof.shadowBytes,0); assert.equal(attaches,0);
      }
    } finally {
      AgentClient.prototype.request = request;
      controller.abort(); await Promise.all(pumps); release(); pause=undefined; await done(run);
    }
  } else if (process.argv[2] === "reconnect terminal") {
    let release!: () => void;
    pause = new Promise<void>(resolve => { release = resolve; });
    const pending = branch(second,"offline completion");
    const run = await as.startProjectRun({nodeId:pending,prompt:"offline completion",attachments:[]});
    daemon.manager.disconnect(run.client.clientId!);
    release(); pause=undefined;
    await done(run);
    assert.equal(repo.getNode(pending)!.status,"done");
    assert.equal(repo.getNode(pending)!.response,`answer ${run.turnId}`);
    assert.equal(engines.reduce((n,e)=>n+e.sent.length,0),3,"reconnect must not repeat engine input");
  } else if (process.argv[2] === "P1-1 non-tip continuation" || oldDaemon) {
    const original = binding.getAsTurn(root)!;
    const source = daemon.server.log.snapshot(original.thread_id).items;
    const boundaryIndex = source.findIndex(i=>i.id === original.last_item_id);
    assert.ok(boundaryIndex >= 0);
    const prefix = source.slice(0,boundaryIndex+1).map(i=>({type:i.type,payload:i.payload}));
    for (const fork of [false,true]) {
      const earlier = branch(root, `earlier question fork=${fork}`);
      const run = await as.startProjectRun({nodeId:earlier,prompt:repo.getNode(earlier)!.question,attachments:[],fork});
      await done(run);
      assert.equal(repo.getNode(earlier)!.status, "done");
      assert.notEqual(run.threadId,original.thread_id);
      const input = JSON.stringify(engines.at(-1)!.sent[0].input);
      const snapshot = daemon.server.log.snapshot(run.threadId);
      if (oldDaemon) {
        assert.equal(run.client.initializeResult?.capabilities.midThreadFork,undefined);
        assert.equal(snapshot.thread.forkedFrom,undefined);
        assert.ok(input.includes("root question"));
        assert.ok(input.includes(repo.getNode(root)!.response));
      } else {
        assert.deepEqual(snapshot.thread.forkedFrom,{threadId:original.thread_id,itemId:original.last_item_id});
        assert.deepEqual(snapshot.items.slice(0,prefix.length).map(i=>({type:i.type,payload:i.payload})),prefix);
        assert.equal(snapshot.items.length,prefix.length+2);
        assert.ok(!input.includes("root question"),"native fork must not re-seed input");
      }
      assert.ok(!input.includes("second question"));
      assert.deepEqual(daemon.server.log.snapshot(original.thread_id).items,source,"source history unchanged");
    }
  } else if (process.argv[2] === "nested native fork") {
    const original = binding.getAsTurn(root)!;
    const source = daemon.server.log.snapshot(original.thread_id);
    const child = branch(root, "first fork");
    const first = await start(child);
    const grandchild = branch(child, "nested fork at inherited boundary");
    // Select an inherited checkpoint in the fork, rather than its new tip.
    getDB().prepare("UPDATE as_turns SET last_item_id=? WHERE node_id=?").run(original.last_item_id, child);
    const secondFork = await as.startProjectRun({nodeId:grandchild,prompt:repo.getNode(grandchild)!.question,attachments:[],fork:true});
    await done(secondFork);
    const options = engines.at(-1)!.options!;
    assert.equal(options.forkSession,true);
    assert.equal(options.forkPoint,`checkpoint-${original.turn_id}`);
    assert.equal(options.seedHistory,undefined,"inherited checkpoints must not degrade to seeding");
    assert.deepEqual(daemon.server.log.snapshot(secondFork.threadId).thread.forkedFrom,{threadId:first.threadId,itemId:original.last_item_id});
    assert.deepEqual(daemon.server.log.snapshot(original.thread_id),source);
  } else if (process.argv[2] === "P0-1 retry preserves answers") {
    const { POST } = await import("../../app/api/chat/route");
    const retryRequest = (nodeId:string) => POST(new Request("http://localhost/api/chat", {method:"POST",body:JSON.stringify({kind:"retry",nodeId,provider:"mock"})}));
    const before = row(second), original = binding.getAsTurn(second)!.thread_id;
    let release!: () => void;
    pause = new Promise<void>(resolve => { release = resolve; });
    const response = await retryRequest(second);
    assert.equal(response.status,200);
    assert.deepEqual(row(second), before, "starting a retry must preserve the full answer");
    assert.equal((await retryRequest(second)).status,409,"a pending replacement cannot be retried concurrently");
    release(); pause = undefined;
    assert.ok((await response.text()).includes('"type":"done"'));
    assert.equal(repo.getNode(second)!.status, "done");
    assert.notEqual(binding.getAsTurn(second)!.thread_id, original, "tip retry uses a native tip fork");
    assert.notDeepEqual(row(second), before);
    fail = true;
    const saved = row(second), savedBinding = binding.getAsTurn(second);
    const failed = await retryRequest(second);
    assert.equal(failed.status,200);
    assert.ok((await failed.text()).includes('"type":"error"'));
    assert.deepEqual(row(second), saved, "failed retry must retain old answer, tools, usage and status");
    assert.deepEqual(binding.getAsTurn(second), savedBinding);
    fail = false;
    const retriedRoot = await retryRequest(root);
    assert.equal(retriedRoot.status,200);
    assert.ok((await retriedRoot.text()).includes('"type":"done"'));
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
  } else if (process.argv[2] === "P2-3 interrupt bypasses peer lease") {
    const pending = branch(second, "interrupt under lease");
    let release!: () => void;
    pause = new Promise<void>(resolve => { release = resolve; });
    const run = await as.startProjectRun({nodeId:pending,prompt:"interrupt under lease",attachments:[]});
    const peer = await AgentClient.connectUnix({path:paths.socketPath,token:loadToken(paths.tokenPath),reconnect:false});
    try {
      await peer.request("thread/attach",{threadId:run.threadId,sinceSeq:0});
      await peer.request("thread/lease/acquire",{threadId:run.threadId,ttlMs:10000});
      await as.interruptProject(pending);
      await done(run);
      assert.equal(repo.getNode(pending)!.status,"error");
      assert.ok(engines.some(e => e.interrupted.includes(run.turnId!)));
    } finally { release(); pause=undefined; peer.close(); }
  } else if (process.argv[2] !== "single project rollout") throw new Error("unknown regression case");
  console.log(`PASS: ${process.argv[2]}`);
} finally {
  await daemon.shutdown();
  getDB().close();
  rmSync(home, { recursive: true, force: true });
}
process.exit(0);
