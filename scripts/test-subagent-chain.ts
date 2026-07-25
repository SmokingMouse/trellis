// Stage 22 regression harness: replay a captured claude stream-json through
// the real pipeline (SDK backend → toStreamEvent → the merge logic run-bus and
// the client store share) and assert the sub-agent chain comes out grouped.
//
// The fixture is a real `claude -p` run that delegated to one general-purpose
// sub-agent (2 Bash calls). Run:  bun scripts/test-subagent-chain.ts
// Re-record against a newer CLI (the task_* lines are undocumented and can
// drift) with:
//   claude -p "<prompt that delegates>" --output-format stream-json --verbose \
//     --include-partial-messages --dangerously-skip-permissions \
//     > scripts/fixtures/subagent-stream.jsonl
// then update the expectations below to match the new run's values.
//
// Runs the fixture through a fake `claude` on PATH, so it exercises the actual
// backend parser rather than a hand-rolled copy of it.

import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ClaudeBackend } from "@sm/agent";
import { toStreamEvent } from "@/lib/llm/sdk-adapter";
import { splitToolChain } from "@/lib/subagents";
import type { ToolCall } from "@/lib/types";

const FIXTURE =
  process.argv[2] ??
  path.join(import.meta.dir, "fixtures", "subagent-stream.jsonl");

function installShim(): string {
  const dir = path.join(os.tmpdir(), "trellis-subagent-shim");
  mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\ncat ${JSON.stringify(FIXTURE)}\n`);
  chmodSync(bin, 0o755);
  return dir;
}

// Mirrors run-bus's committedToolCalls + the client store's merge rules.
function applyEvents(events: ReturnType<typeof toStreamEvent>[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const e of events) {
    if (!e) continue;
    if (e.type === "tool_call_start") {
      calls.push({
        id: e.id,
        name: e.name,
        input: e.input,
        output: null,
        stderr: null,
        status: "running",
        durationMs: null,
        startedAt: e.startedAt,
        endedAt: null,
        parentToolUseId: e.parentToolUseId ?? null,
      });
    } else if (e.type === "tool_call_done") {
      const c = calls.find((x) => x.id === e.id);
      if (c) {
        c.output = e.output;
        c.status = e.isError ? "error" : "done";
        c.endedAt = e.endedAt;
      }
    } else if (e.type === "tool_call_update") {
      const c = calls.find((x) => x.id === e.id);
      if (c) c.agent = { ...c.agent, ...e.agent };
    }
  }
  return calls;
}

let failures = 0;
function check(label: string, ok: boolean, got?: unknown) {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`);
  }
}

const shimDir = installShim();
process.env.PATH = `${shimDir}:${process.env.PATH}`;

const events: ReturnType<typeof toStreamEvent>[] = [];
for await (const e of new ClaudeBackend().run("replay", { workspace: os.tmpdir() })) {
  events.push(toStreamEvent(e));
}

const calls = applyEvents(events);
const { main, groups } = splitToolChain(calls);
const g = groups[0];

console.log(`\nfixture: ${FIXTURE}\ncalls: ${calls.length}, main: ${main.length}, groups: ${groups.length}\n`);
check("恰好一个子 Agent 分组", groups.length === 1, groups.length);
check("主链不含子 agent 的工具", main.length === 0, main.map((c) => c.name));
check("父调用是 Agent 且无 parent", g?.call.name === "Agent" && !g.call.parentToolUseId);
check("两条 Bash 挂在子 agent 名下", g?.children.length === 2, g?.children.map((c) => c.name));
check("子 agent 类型来自 task_started", g?.meta.subagentType === "general-purpose", g?.meta.subagentType);
check("任务 prompt 有透传", Boolean(g?.meta.prompt?.startsWith("Run these two shell")), g?.meta.prompt?.slice(0, 30));
check("完成后描述回落原始任务（非最后一步）", g?.meta.description === "Run echo and ls commands", g?.meta.description);
check("usage 落到 meta", g?.meta.toolUses === 2 && g?.meta.totalTokens === 36508, [g?.meta.toolUses, g?.meta.totalTokens]);
check("最终报告可见", Boolean(g?.report?.includes("hello-from-subagent")), g?.report?.slice(0, 40));
check("进度 patch 未覆盖 summary", Boolean(g?.meta.summary) && g?.meta.status === "completed", g?.meta.status);
check("子调用状态已收敛", g?.children.every((c) => c.status === "done"), g?.children.map((c) => c.status));

console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
