// Independent repro driver for fj-cxint-review-f43c. Runs against an isolated
// agent-server daemon; never touches the resident daemon.
const { connectUnix } = await import(`${process.env.PROBE_ROOT}/packages/agent-server/dist/client/index.js`);
import { readFileSync, appendFileSync } from "node:fs";

const scenario = process.argv[2] ?? "A";
const socket = process.env.PROBE_SOCKET!;
const token = readFileSync(process.env.PROBE_TOKEN!, "utf8").trim();
const cwd = process.env.PROBE_CWD!;
const model = process.env.PROBE_MODEL ?? "gpt-6-astra";
const log = process.env.PROBE_LOG!;
const t0 = Date.now();
const rec = (tag: string, data: unknown = {}) => {
  const line = JSON.stringify({ ms: Date.now() - t0, tag, data });
  appendFileSync(log, line + "\n");
  console.log(line.slice(0, 400));
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const client = await connectUnix({
  path: socket, token,
  client: { name: "cxint-probe", version: "0.0.1", kind: "cli", label: "probe" },
  capabilities: { pendingRequests: true, engineEvents: true },
  reconnect: false,
});
rec("connected", client.initializeResult?.capabilities?.backends);

const completed: Record<string, number> = {};
const started: Record<string, string> = {};
client.onNotification("item/started", p => { started[p.item.id] = p.item.type; rec("item/started", { id: p.item.id, type: p.item.type, status: p.item.status, payload: p.item.type === "commandExecution" ? p.item.payload : undefined }); });
client.onNotification("item/completed", p => { completed[p.item.id] = (completed[p.item.id] ?? 0) + 1; rec("item/completed", { id: p.item.id, type: p.item.type, status: p.item.status, n: completed[p.item.id], payload: p.item.type === "commandExecution" ? p.item.payload : undefined }); });
client.onNotification("turn/started", p => rec("turn/started", { turnId: p.turnId }));
client.onNotification("turn/completed", p => rec("turn/completed", { turnId: p.turnId, status: p.turn.status }));
client.onNotification("thread/status/changed", p => rec("thread/status", p.status));
client.onNotification("error", p => rec("error", p));
client.onNotification("thread/engineEvent", p => {
  if (["turn/interrupt", "turn/completed", "item/completed", "item/started"].includes(p.subtype)) rec("engineEvent", { subtype: p.subtype, status: (p.payload as any)?.turn?.status ?? (p.payload as any)?.item?.status, itemType: (p.payload as any)?.item?.type });
});
client.onServerRequest("item/commandExecution/requestApproval" as any, (r: any) => { rec("approvalReq", r.params?.command); r.respond({ decision: "accept" }); });

const { thread } = await client.request("thread/start", { backend: "codex", model, cwd, permission: "full" } as any);
rec("thread/start", { threadId: thread.id });

const prompts: Record<string, string> = {
  A: "Run exactly this shell command in the foreground and wait for it: sleep 600. Do not background it, do not use & or nohup, do not add a timeout. Just run `sleep 600`.",
  B: "Run exactly this shell command in the foreground and wait for it: sleep 600. Do not background it. Just run `sleep 600`.",
  C: "Run exactly two shell commands, one after the other: first `echo first-command-done`, then `sleep 600` in the foreground. Do not background anything.",
  D: "Run exactly this shell command in the foreground and wait for it: sleep 600. Do not background it. Just run `sleep 600`.",
  E: "Write a long, detailed essay (at least 1500 words) about the history of the Unix shell. Do not run any commands. Start writing immediately.",
  F: "Run exactly this shell command in the foreground: `for i in $(seq 1 100000); do echo tick-$i; sleep 0.05; done`. Do not background it.",
};

const turn = await client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: prompts[scenario] }] } as any);
rec("turn/start", { turnId: turn.turn.id });


const waitForExec = async (limitMs: number) => {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const id = Object.entries(started).find(([id, type]) => type === "commandExecution" && !completed[id]);
    if (id) return id[0];
    await sleep(200);
  }
  return undefined;
};

let deltas = 0, outputDeltas = 0;
client.onNotification("item/agentMessage/delta", () => { deltas++; if (deltas <= 3) rec("agentDelta", deltas); });
client.onNotification("item/commandExecution/outputDelta", () => { outputDeltas++; if (outputDeltas <= 3) rec("outputDelta", outputDeltas); });

if (scenario === "E" || scenario === "F") {
  // Interrupt mid-stream: an in-flight delta must not kill the engine.
  const deadline = Date.now() + 180_000;
  const target = () => (scenario === "E" ? deltas : outputDeltas);
  while (Date.now() < deadline && target() < 2) await sleep(50);
  rec("mid-stream", { deltas, outputDeltas });
  await client.request("turn/interrupt", { threadId: thread.id, turnId: turn.turn.id } as any);
  rec("interrupt:ack", { deltas, outputDeltas });
} else if (scenario === "B") {
  // Interrupt as soon as the turn is accepted, before any command item exists.
  rec("interrupt:immediate");
  try {
    await client.request("turn/interrupt", { threadId: thread.id, turnId: turn.turn.id } as any);
    rec("interrupt:ack");
  } catch (error: any) { rec("interrupt:error", { code: error?.code, message: String(error?.message ?? error) }); }
  const execId = await waitForExec(180_000);
  rec("exec-item-after-early-interrupt", { execId });
  if (execId) {
    await sleep(3000);
    try {
      await client.request("turn/interrupt", { threadId: thread.id, turnId: turn.turn.id } as any);
      rec("interrupt2:ack");
    } catch (error: any) { rec("interrupt2:error", { code: error?.code, message: String(error?.message ?? error) }); }
  }
} else {
  const execId = await waitForExec(180_000);
  rec("exec-item", { execId });
  if (!execId) { rec("FATAL", "no commandExecution item observed"); }
  else {
    await sleep(3000);
    rec("interrupt:send", { execId });
    await client.request("turn/interrupt", { threadId: thread.id, turnId: turn.turn.id } as any);
    rec("interrupt:ack");
  }
}

if (scenario === "D") {
  await sleep(1500);
  try {
    const t2 = await client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Reply with the single word OK. Do not run any command." }] } as any);
    rec("turn2/start", { turnId: t2.turn.id });
  } catch (error: any) { rec("turn2/error", { message: String(error?.message ?? error), code: error?.code }); }
}

// Observe for 20s after the interrupt.
for (let i = 0; i < 20; i++) {
  await sleep(1000);
  if (i === 9) {
    const pg = Bun.spawnSync(["pgrep", "-fl", "sleep 600"]);
    rec("pgrep@10s", { out: pg.stdout.toString().trim(), exit: pg.exitCode });
  }
}
const pg2 = Bun.spawnSync(["pgrep", "-fl", "sleep 600"]);
rec("pgrep@20s", { out: pg2.stdout.toString().trim(), exit: pg2.exitCode });

const items = await client.request("thread/items/list", { threadId: thread.id } as any);
rec("items", items.items.map((i: any) => ({ id: i.id, type: i.type, status: i.status })));
const dup = Object.entries(completed).filter(([, n]) => n > 1);
rec("duplicate-completed", dup);

try {
  await client.request("thread/close", { threadId: thread.id, reason: "probe done" } as any);
  rec("thread/close", "ok");
} catch (error: any) { rec("thread/close:error", String(error?.message ?? error)); }

await sleep(1500);
const pg3 = Bun.spawnSync(["pgrep", "-fl", "sleep 600"]);
rec("pgrep@after-close", { out: pg3.stdout.toString().trim(), exit: pg3.exitCode });
client.close();
process.exit(0);
