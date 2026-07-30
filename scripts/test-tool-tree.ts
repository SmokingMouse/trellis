// Regression harness for the tool timeline: replay captured claude
// stream-json through the real pipeline (SDK backend → toStreamEvent → the
// merge logic run-bus and the client store share) and assert buildToolTree
// classifies each of the three task kinds correctly.
//
// Three fixtures, one per task_type, because the bug this replaces was
// precisely a missing distinction — the old harness only had the clean
// sub-agent case and so passed while slow Bash commands were being rendered
// as sub-agents with their output thrown away.
//
//   subagent-stream.jsonl   local_agent     one general-purpose agent, 2 Bash
//   bash-task-stream.jsonl  local_bash      one backgrounded + one slow Bash
//   workflow-stream.jsonl   local_workflow  2 phases × 1 agent
//
// Run:  bun scripts/test-tool-tree.ts
//
// Re-record against a newer CLI (the task_* lines are undocumented and can
// drift) with:
//   claude -p "<prompt>" --output-format stream-json --verbose \
//     --dangerously-skip-permissions > scripts/fixtures/<name>.jsonl
// then update the expectations below to match the new run's values.

import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ClaudeBackend } from "@smokingmouse/agent";
import { toStreamEvent } from "@/lib/llm/sdk-adapter";
import { buildToolTree, walkToolTree, type ToolNode } from "@/lib/tool-tree";
import type { ToolCall } from "@/lib/types";

const FIXTURES = path.join(import.meta.dir, "fixtures");

function installShim(fixture: string): string {
  const dir = path.join(os.tmpdir(), "trellis-tool-tree-shim");
  mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\ncat ${JSON.stringify(fixture)}\n`);
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

async function replay(fixture: string): Promise<ToolNode[]> {
  const shimDir = installShim(path.join(FIXTURES, fixture));
  process.env.PATH = `${shimDir}:${process.env.PATH}`;
  const events: ReturnType<typeof toStreamEvent>[] = [];
  for await (const e of new ClaudeBackend().run("replay", {
    workspace: os.tmpdir(),
  })) {
    events.push(toStreamEvent(e));
  }
  return buildToolTree(applyEvents(events));
}

let failures = 0;
function check(label: string, ok: boolean, got?: unknown) {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(
      `  ✗ ${label}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`,
    );
  }
}

function section(name: string) {
  console.log(`\n── ${name}`);
}

// SDK 闸：taskType / workflowProgress / 空 stdout 让位 content 三项都在
// @smokingmouse/agent ≥0.3.3。装着 0.3.2 时下面会红一片，但根因是**依赖没到位**
// 而不是代码退化 —— 先说清楚，省得下一个人对着 9 条红断言查一小时。
{
  const probe = await replay("bash-task-stream.jsonl");
  if (!probe.some((n) => n.meta.taskType)) {
    console.log(
      "\n⚠️  当前 @smokingmouse/agent 没有透传 task_type —— 需要 ≥0.3.3。\n" +
        "   分类靠 taskId 前缀仍然正确，但 workflowProgress 拿不到、\n" +
        "   且空 stdout 会把 content 顶掉（后台命令输出为空）。\n" +
        "   本地开发：make link-sdk；上线前：发 0.3.3 再 bun install。",
    );
  }
}

// ── local_agent ──────────────────────────────────────────────────────────
{
  const tree = await replay("subagent-stream.jsonl");
  section(`local_agent (${tree.length} 顶层节点)`);
  const agents = tree.filter((n) => n.kind === "subagent");
  const a = agents[0];
  check("恰好一个子 Agent", agents.length === 1, tree.map((n) => n.kind));
  check("子 agent 在顶层且无 parent", !a?.call.parentToolUseId);
  check("taskType 已透传到 UI 层", a?.meta.taskType === "local_agent", a?.meta.taskType);
  check("两条 Bash 嵌在它下面", a?.children.length === 2, a?.children.map((c) => c.call.name));
  check(
    "子调用不出现在顶层",
    tree.every((n) => n.kind === "subagent" || n.children.length === 0),
    tree.map((n) => `${n.kind}:${n.call.name}`),
  );
  check("类型来自 task_started", a?.meta.subagentType === "general-purpose", a?.meta.subagentType);
  check("任务 prompt 有透传", Boolean(a?.meta.prompt?.startsWith("Run these two shell")));
  check(
    "完成后描述回落原始任务（非最后一步）",
    a?.meta.description === "Run echo and ls commands",
    a?.meta.description,
  );
  check("usage 落到 meta", a?.meta.toolUses === 2 && a?.meta.totalTokens === 36508, [
    a?.meta.toolUses,
    a?.meta.totalTokens,
  ]);
  check("最终报告可见", Boolean(a?.report?.includes("hello-from-subagent")), a?.report?.slice(0, 40));
  check("进度 patch 未覆盖 summary", Boolean(a?.meta.summary) && a?.meta.status === "completed");
  check(
    "子调用状态已收敛",
    a?.children.every((c) => c.call.status === "done"),
    a?.children.map((c) => c.call.status),
  );
}

// ── local_bash ───────────────────────────────────────────────────────────
// The regression that started all this. Both of these get task_* lines — the
// second one isn't even backgrounded, just slow — and used to be rendered as
// sub-agents whose "report" was the description echoed back, with the actual
// stdout dropped on the floor.
{
  const tree = await replay("bash-task-stream.jsonl");
  section(`local_bash (${tree.length} 顶层节点)`);
  const bash = tree.filter((n) => n.kind === "longRunning");
  check("没有任何东西被当成子 Agent", tree.every((n) => n.kind !== "subagent"), tree.map((n) => n.kind));
  check("两条都归为长跑命令", bash.length === 2, tree.map((n) => `${n.kind}:${n.call.name}`));
  check("taskType 是 local_bash", bash.every((n) => n.meta.taskType === "local_bash"), bash.map((n) => n.meta.taskType));
  check("不吞掉 report 字段", bash.every((n) => n.report === null));
  // 空 stdout 曾经把 content 顶掉（SDK 的 `stdout ?? content`），于是这两条
  // 的输出双双成了空串 —— 叠加「被当子 Agent 吞进分组」，命令结果彻底消失。
  check(
    "后台命令的回执仍在（这条塌了就是结果不可见）",
    bash.some((n) => n.call.output?.includes("Command running in background")),
    bash.map((n) => n.call.output?.slice(0, 40)),
  );
  check(
    "无输出的命令也说清楚了，而不是空白",
    bash.some((n) => n.call.output?.includes("no output")),
    bash.map((n) => n.call.output?.slice(0, 40)),
  );
  check(
    "CLI 的 summary 确实是描述回声（bug 的根因还在，只是不再被采信）",
    bash.some((n) => n.meta.summary === n.meta.description),
    bash.map((n) => [n.meta.summary, n.meta.description]),
  );
  check("没有虚假的子节点", bash.every((n) => n.children.length === 0));
}

// ── local_workflow ───────────────────────────────────────────────────────
{
  const tree = await replay("workflow-stream.jsonl");
  section(`local_workflow (${tree.length} 顶层节点)`);
  const wf = tree.find((n) => n.kind === "workflow");
  check("Workflow 被识别出来", Boolean(wf), tree.map((n) => `${n.kind}:${n.call.name}`));
  check("没被误当子 Agent", tree.every((n) => n.kind !== "subagent"), tree.map((n) => n.kind));
  check("taskType 是 local_workflow", wf?.meta.taskType === "local_workflow", wf?.meta.taskType);
  check("workflow_name 已透传", wf?.meta.workflowName === "probe-wf", wf?.meta.workflowName);

  const prog = wf?.meta.workflowProgress ?? [];
  const phases = prog.filter((e) => e.type === "workflow_phase");
  const agents = prog.filter((e) => e.type === "workflow_agent");
  check("两个 phase 到位", phases.length === 2, phases);
  check(
    "phase 标题正确",
    phases.every((p) => p.type === "workflow_phase" && ["Alpha", "Beta"].includes(p.title)),
    phases,
  );
  check("两个 agent 到位", agents.length === 2, agents.length);
  check(
    "agent 带 label / phaseTitle / state",
    agents.every(
      (a) => a.type === "workflow_agent" && a.label && a.phaseTitle && a.state,
    ),
    agents,
  );
  check(
    "跑完的 agent 带结果预览",
    agents.some((a) => a.type === "workflow_agent" && a.resultPreview === "ALPHA_OK"),
    agents.map((a) => (a.type === "workflow_agent" ? a.resultPreview : null)),
  );
  check(
    "快照是最后一份（不是第一份 start 态）",
    agents.every((a) => a.type === "workflow_agent" && a.state === "done"),
    agents.map((a) => (a.type === "workflow_agent" ? a.state : null)),
  );
}

// ── 降级链 ───────────────────────────────────────────────────────────────
// taskType 只有 @sm/agent ≥0.3.3 才透传。旧行 / 其他后端拿不到它时，分类必须
// 靠 taskId 首字母，再靠工具名 —— 否则升级 SDK 之前这个修复根本落不了地。
{
  section("降级链（无 taskType）");
  const at = (id: string, name: string, agent?: Record<string, unknown>): ToolCall => ({
    id,
    name,
    input: {},
    output: null,
    stderr: null,
    status: "done",
    durationMs: 1,
    startedAt: Number(id.replace(/\D/g, "")) || 1,
    endedAt: 2,
    ...(agent ? { agent } : {}),
  });
  const tree = buildToolTree([
    at("1", "Bash", { taskId: "b0woneroo" }),
    at("2", "Bash", { taskId: "a6f5dcdcd" }),
    at("3", "Bash", { taskId: "wosg0z3kd" }),
    at("4", "Agent"),
    at("5", "Workflow"),
    at("6", "Bash"),
  ]);
  const kinds = tree.map((n) => n.kind);
  check("b… 前缀 → 长跑命令", kinds[0] === "longRunning", kinds[0]);
  check("a… 前缀 → 子 Agent", kinds[1] === "subagent", kinds[1]);
  check("w… 前缀 → Workflow", kinds[2] === "workflow", kinds[2]);
  check("无 task 元信息时按工具名：Agent", kinds[3] === "subagent", kinds[3]);
  check("无 task 元信息时按工具名：Workflow", kinds[4] === "workflow", kinds[4]);
  check("普通 Bash 还是普通工具", kinds[5] === "tool", kinds[5]);

  // 孤儿子调用（父不在本轮列表里）必须留在顶层，不能凭空消失。
  const orphan = buildToolTree([
    { ...at("7", "Read"), parentToolUseId: "not-here" },
  ]);
  check("父不在列表里的子调用不会消失", orphan.length === 1, orphan.length);

  // parentToolUseId 成环时递归必须收敛。
  const cyclic = buildToolTree([
    { ...at("8", "Bash"), parentToolUseId: "9" },
    { ...at("9", "Bash"), parentToolUseId: "8" },
  ]);
  check("环不会打挂遍历", walkToolTree(cyclic).length <= 2, walkToolTree(cyclic).length);
}

// ── 树不变式 ─────────────────────────────────────────────────────────────
{
  section("树不变式");
  const tree = await replay("subagent-stream.jsonl");
  const all = walkToolTree(tree);
  const ids = all.map((n) => n.call.id);
  check("没有节点重复出现", new Set(ids).size === ids.length, ids.length - new Set(ids).size);
  check(
    "顶层按时间排序",
    tree.every((n, i) => i === 0 || tree[i - 1].call.startedAt <= n.call.startedAt),
  );
  check("空输入返回空树", buildToolTree([]).length === 0);
}

console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
