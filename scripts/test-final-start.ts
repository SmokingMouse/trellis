// Regression harness：response 分层（finalStart）两个状态机的行为核对。
//   A. run-bus 流式版 —— 用 mock provider 事件序列驱动真实 startRun/subscribe，
//      断言段落分隔插入 + finalStart 落库 + done 事件携带。
//   B. cli-import 解析版 —— 手造 jsonl entries，断言块结构精确偏移。
// Run:  bun --conditions react-server scripts/test-final-start.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 隔离 DB：真库绝不碰。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-finalstart-"));
process.env.TRELLIS_DB_PATH = path.join(tmp, "test.db");

const { parseCliSessionJsonl } = await import("../lib/server/cli-import");

let failed = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`}`);
  if (!ok) failed++;
}

// ── B. cli-import 解析版 ────────────────────────────────────────────────────
{
  const mkEntry = (o: Record<string, unknown>) => JSON.stringify(o);
  const jsonl = [
    mkEntry({
      type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-08-18T10:00:00Z",
      sessionId: "s1", cwd: "/tmp", message: { role: "user", content: "问题" },
    }),
    // text A → tool_use → text B → thinking → text C(最终答复)
    mkEntry({
      type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-08-18T10:00:01Z",
      message: { role: "assistant", content: [
        { type: "text", text: "先看一下。" },
        { type: "tool_use", id: "t1", name: "Bash", input: {} },
      ] },
    }),
    mkEntry({
      type: "user", uuid: "r1", parentUuid: "a1", timestamp: "2026-08-18T10:00:02Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    }),
    mkEntry({
      type: "assistant", uuid: "a2", parentUuid: "r1", timestamp: "2026-08-18T10:00:03Z",
      message: { role: "assistant", content: [
        { type: "text", text: "查到了。" },
        { type: "thinking", thinking: "想一想" },
        { type: "text", text: "最终答复。" },
      ] },
    }),
  ].join("\n");
  const p = path.join(tmp, "fake.jsonl");
  fs.writeFileSync(p, jsonl);
  const parsed = parseCliSessionJsonl(p)!;
  const turn = parsed.turns[0];
  // parts: ["先看一下。", "查到了。", "最终答复。"] → join("\n\n")
  check("cli-import response 分段", turn.response, "先看一下。\n\n查到了。\n\n最终答复。");
  const wantOffset = "先看一下。\n\n查到了。".length + 2;
  check("cli-import finalStart 偏移", turn.finalStart, wantOffset);
  check("cli-import 最终段内容", turn.response.slice(turn.finalStart!), "最终答复。");

  // 纯回答（无工具/思考）→ 不分层
  const jsonl2 = [
    mkEntry({
      type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-08-18T10:00:00Z",
      sessionId: "s2", cwd: "/tmp", message: { role: "user", content: "问题" },
    }),
    mkEntry({
      type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-08-18T10:00:01Z",
      message: { role: "assistant", content: [{ type: "text", text: "直接答。" }] },
    }),
  ].join("\n");
  const p2 = path.join(tmp, "fake2.jsonl");
  fs.writeFileSync(p2, jsonl2);
  check("cli-import 纯回答不分层", parseCliSessionJsonl(p2)!.turns[0].finalStart, 0);

  // 以工具收尾（中断后无正文）→ finalStart 停在最后一段实际正文
  const jsonl3 = [
    mkEntry({
      type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-08-18T10:00:00Z",
      sessionId: "s3", cwd: "/tmp", message: { role: "user", content: "问题" },
    }),
    mkEntry({
      type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-08-18T10:00:01Z",
      message: { role: "assistant", content: [
        { type: "text", text: "A段。" },
        { type: "tool_use", id: "t1", name: "Bash", input: {} },
        { type: "text", text: "B段。" },
        { type: "tool_use", id: "t2", name: "Bash", input: {} },
      ] },
    }),
  ].join("\n");
  const p3 = path.join(tmp, "fake3.jsonl");
  fs.writeFileSync(p3, jsonl3);
  const t3 = parseCliSessionJsonl(p3)!.turns[0];
  check("cli-import 工具收尾 finalStart 指向 B 段", t3.response.slice(t3.finalStart!), "B段。");
}

// ── A. run-bus 流式版 ───────────────────────────────────────────────────────
{
  const runBus = await import("../lib/server/run-bus");
  const { createSessionWithRoot, getNode } = await import("../lib/server/repo");
  const { startRun, subscribe } = runBus;
  type ProviderEvent = import("../lib/server/run-bus").ProviderEvent;
  type BusEvent =
    | import("../lib/server/run-bus").RunEvent
    | import("../lib/server/run-bus").CatchupEvent;
  type DoneEvent = Extract<BusEvent, { type: "done" }>;

  const nodeId = "test-node-1";
  createSessionWithRoot({
    sessionId: "test-session-1",
    nodeId,
    title: "t",
    question: "q",
    now: Date.now(),
    mode: "project",
    workspacePath: null,
  });

  const events: ProviderEvent[] = [
    { type: "delta", text: "先看" },
    { type: "delta", text: "一下。" },
    { type: "tool_call_start", id: "t1", name: "Bash", input: {}, startedAt: 1, parentToolUseId: null },
    { type: "tool_call_done", id: "t1", output: "ok", stderr: null, isError: false, endedAt: 2 },
    { type: "delta", text: "查到了。" },
    { type: "thinking", text: "想想" },
    { type: "delta", text: "最终" },
    { type: "delta", text: "答复。" },
    { type: "done", usage: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 } },
  ];

  const doneEvent = await new Promise<DoneEvent | null>((resolve) => {
    let captured: DoneEvent | null = null;
    startRun({
      nodeId,
      resumeFamily: "mock",
      factory: async function* () {
        for (const e of events) yield e;
      },
    });
    // startRun 在下一个 microtask 才跑 runLoop —— 立即订阅仍先收 catchup。
    subscribe(nodeId, {
      onEvent: (e: BusEvent) => {
        if (e.type === "done") captured = e;
      },
      onClose: () => resolve(captured),
    });
  });

  const row = getNode(nodeId)!;
  check("run-bus response 分段", row.response, "先看一下。\n\n查到了。\n\n最终答复。");
  const wantFS = "先看一下。\n\n查到了。\n\n".length;
  check("run-bus final_start 落库", row.finalStart, wantFS);
  check("run-bus 最终段内容", row.response.slice(row.finalStart!), "最终答复。");
  check("run-bus done 事件携带 finalStart", doneEvent?.finalStart, wantFS);
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
