// Deterministic producer using only the agent-server package's public APIs.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentClient, MockEngine, type MockScript } from "@smokingmouse/agent-server";
import { loadToken, resolveDaemonPaths, runDaemon } from "@smokingmouse/agent-server/daemon";
import { itemText } from "../../lib/as-log";

const home = process.argv[2];
if (!home || !home.startsWith("/tmp/trellis-as-shadow-")) throw new Error("isolated home required");
const paths = resolveDaemonPaths({ NODE_ENV: "test", HOME: home, AGENT_SERVER_SOCKET_PATH: join(home, "as.sock") });
async function waitFile(name: string) {
  const deadline = Date.now() + 180000;
  while (!existsSync(join(home, name))) {
    if (Date.now() > deadline) throw new Error(`fixture timeout: ${name}`);
    await Bun.sleep(50);
  }
}
const script: MockScript = async function* (turnId, _input, engine) {
  yield { type: "itemStarted", turnId, item: { id: "thought", type: "reasoning", payload: { text: "" } } };
  yield { type: "itemDelta", turnId, itemId: "thought", kind: "reasoning", text: "先核对同一份日志。" };
  yield { type: "itemCompleted", turnId, item: { id: "thought", type: "reasoning", payload: { text: "先核对同一份日志。" } } };
  yield { type: "itemStarted", turnId, item: { id: "command", type: "commandExecution", payload: { command: "printf shadow-proof", cwd: home } } };
  yield { approval: { method: "item/commandExecution/requestApproval", params: {
    requestId: "shadow-approval", threadId: engine.options!.threadId, turnId, itemId: "command",
    command: "printf shadow-proof", cwd: home, startedAtMs: Date.now(),
  } } };
  yield { type: "itemDelta", turnId, itemId: "command", kind: "stdout", text: "shadow-proof" };
  yield { type: "itemCompleted", turnId, item: { id: "command", type: "commandExecution", payload: { command: "printf shadow-proof", cwd: home, aggregatedOutput: "shadow-proof", exitCode: 0 } } };
  yield { type: "itemStarted", turnId, item: { id: "answer", type: "agentMessage", payload: { text: "" } } };
  yield { type: "itemDelta", turnId, itemId: "answer", kind: "text", text: "实时片段已到达。" };
  await waitFile("tail");
  const tail = "\n" + "长日志追加验证。\n".repeat(40);
  yield { type: "itemDelta", turnId, itemId: "answer", kind: "text", text: tail };
  await waitFile("tail2");
  const tail2 = "再次追加并自动跟随。\n".repeat(10);
  yield { type: "itemDelta", turnId, itemId: "answer", kind: "text", text: tail2 };
  await waitFile("finish");
  yield { type: "itemCompleted", turnId, item: { id: "answer", type: "agentMessage", payload: { text: "实时片段已到达。" + tail + tail2 + "离线片段完整补齐。" } } };
  const changes = [{ path: `${home}/${"long-path-".repeat(12)}proof.txt`, kind: "add" as const, diff: "+ shadow-proof\n+ resume-proof" }];
  yield { type: "itemStarted", turnId, item: { id: "file", type: "fileChange", payload: { changes, status: "inProgress" } } };
  yield { type: "itemCompleted", turnId, item: { id: "file", type: "fileChange", payload: { changes, status: "completed" } } };
  yield { type: "turnCompleted", turnId, status: "completed" };
};
const daemon = await runDaemon({ paths, graceMs: 0, serverOptions: {
  engineFactory: () => new MockEngine(script, "codex"), allowedRoots: [home], orphanTimeoutMs: 120000,
} });
const producer = await AgentClient.connectUnix({ path: paths.socketPath, token: loadToken(paths.tokenPath),
  capabilities: { serverRequests: ["item/commandExecution/requestApproval"] }, reconnect: false });
producer.onServerRequest("item/commandExecution/requestApproval", request => {
  void waitFile("approve").then(() => request.respond({ decision: "accept" }));
});
producer.onNotification("turn/completed", () => {
  void producer.request("thread/attach", { threadId: thread.id, sinceSeq: 0 }).then(snapshot => {
    writeFileSync(join(home, "expected.json"), JSON.stringify({ cursor: snapshot.nextSeq - 1,
      items: snapshot.items.map(item => ({ id: item.id, status: item.status, text: itemText(item) })), snapshot }, null, 2));
  });
});
const { thread } = await producer.request("thread/start", { backend: "codex", cwd: home });
writeFileSync(join(home, "thread-id"), thread.id);
let ending = false;
async function stop() { if (ending) return; ending = true; producer.close(); await daemon.shutdown(); process.exit(0); }
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
await waitFile("start");
await producer.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "验证实时与断点续传" }] });
await daemon.closed;
