// Fixture 生成器：把 Workflow 动线卡的五种状态写成 SQL，喂给隔离实例的库副本。
//
//   运行中 / 已完成 / 已失败 / 无阶段明细 / 53 个 agent 的规模态
//   外加一个普通动线节点（普通行 + 子 Agent + 长跑 Bash 同框，给 P1 行语言拍照）
//
// 用法：bun scripts/mobile-verify/workflow-card-fixture.ts > fixture.sql
//
// 这里造的是 nodes.tool_calls_json —— 和真实流写进去的是同一列同一形状，所以
// 前端走的是完全一样的渲染路径，没有任何测试专用分支。

import type { ToolCall, WorkflowProgressEntry } from "../../lib/types";

const now = Date.now();
// 基准放在「刚刚」：动线是按 startedAt 排序的，把它钉在未来某个固定时刻会让
// 运行中的那条 Workflow 插到普通行前面去，截图就不是真实顺序了。
const T0 = now - 1_800_000;

type Agent = {
  label: string;
  phase: number;
  state: string;
  model?: string;
  fallbackModel?: string;
  attempt?: number;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  queuedAt?: number;
  startedAt?: number;
  lastProgressAt?: number;
  promptPreview?: string;
  resultPreview?: string;
};

let agentSeq = 0;
function agentEntry(a: Agent, phaseTitle: string): WorkflowProgressEntry {
  agentSeq += 1;
  return {
    type: "workflow_agent",
    index: agentSeq,
    label: a.label,
    phaseIndex: a.phase,
    phaseTitle,
    agentId: `a${agentSeq.toString(16)}${a.label.length}`,
    model: a.model ?? "claude-opus-5[1m]",
    fallbackModel: a.fallbackModel,
    state: a.state,
    attempt: a.attempt,
    queuedAt: a.queuedAt,
    startedAt: a.startedAt,
    lastProgressAt: a.lastProgressAt,
    tokens: a.tokens,
    toolCalls: a.toolCalls,
    durationMs: a.durationMs,
    promptPreview: a.promptPreview,
    resultPreview: a.resultPreview,
  };
}

function progress(
  phases: { index: number; title: string }[],
  agents: Agent[],
): WorkflowProgressEntry[] {
  agentSeq = 0;
  const titleOf = new Map(phases.map((p) => [p.index, p.title]));
  return [
    ...phases.map((p) => ({
      type: "workflow_phase" as const,
      index: p.index,
      title: p.title,
    })),
    ...agents.map((a) => agentEntry(a, titleOf.get(a.phase) ?? "")),
  ];
}

const call = (over: Partial<ToolCall> & Pick<ToolCall, "id" | "name">): ToolCall => ({
  input: {},
  output: null,
  stderr: null,
  status: "done",
  durationMs: 120,
  startedAt: T0,
  endedAt: T0 + 120,
  ...over,
});

const SCRIPT = `export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }, { title: 'Synthesize' }],
}
const DIMENSIONS = [{key:'bugs'},{key:'perf'},{key:'security'},{key:'tests'}]
const results = await pipeline(DIMENSIONS, d => agent(d.prompt, {label: \`review:\${d.key}\`}))
return { results }`;

// ── 1 · 运行中 ────────────────────────────────────────────────────────────

const runningAgents: Agent[] = [
  { label: "review:bugs", phase: 1, state: "done", tokens: 48000, toolCalls: 14, durationMs: 130000, queuedAt: T0, startedAt: T0, lastProgressAt: T0 + 130000, resultPreview: "3 findings" },
  { label: "review:perf", phase: 1, state: "done", tokens: 39000, toolCalls: 11, durationMs: 108000, queuedAt: T0, startedAt: T0, lastProgressAt: T0 + 108000 },
  { label: "review:security", phase: 1, state: "start", tokens: 21000, toolCalls: 9, queuedAt: T0, startedAt: T0 + 160000, lastProgressAt: T0 + 221000 },
  { label: "review:tests", phase: 1, state: "queued", queuedAt: T0 },
  { label: "verify:auth.ts", phase: 2, state: "done", model: "claude-haiku-4-5-20251001", tokens: 31000, toolCalls: 6, durationMs: 80000, queuedAt: T0 + 130000, startedAt: T0 + 130000, lastProgressAt: T0 + 210000 },
  { label: "verify:api.ts", phase: 2, state: "done", model: "claude-haiku-4-5-20251001", tokens: 27000, toolCalls: 5, durationMs: 65000, queuedAt: T0 + 108000, startedAt: T0 + 108000, lastProgressAt: T0 + 173000 },
  { label: "verify:db.ts", phase: 2, state: "start", model: "claude-haiku-4-5-20251001", fallbackModel: "claude-sonnet-5", attempt: 2, tokens: 12000, toolCalls: 3, queuedAt: T0 + 130000, startedAt: T0 + 181000, lastProgressAt: T0 + 222000 },
  { label: "verify:ui.ts", phase: 2, state: "queued", model: "claude-haiku-4-5-20251001", queuedAt: T0 + 210000 },
  { label: "verify:cli.ts", phase: 2, state: "queued", model: "claude-haiku-4-5-20251001", queuedAt: T0 + 173000 },
  { label: "verify:docs.ts", phase: 2, state: "queued", model: "claude-haiku-4-5-20251001", queuedAt: T0 + 221000 },
  { label: "synthesize:report", phase: 3, state: "queued" },
];

const WF_PHASES = [
  { index: 1, title: "Review" },
  { index: 2, title: "Verify" },
  { index: 3, title: "Synthesize" },
];

const runningCalls: ToolCall[] = [
  call({ id: "r1", name: "Read", input: { file_path: "/repo/docs/events.md" } }),
  call({ id: "r2", name: "Bash", input: { command: "git status" }, output: "clean" }),
  call({
    id: "r3",
    name: "Workflow",
    status: "running",
    durationMs: null,
    endedAt: null,
    startedAt: now - 222000,
    input: { script: SCRIPT },
    agent: {
      taskType: "local_workflow",
      taskId: "wl2zl75gq",
      phase: "progress",
      workflowName: "review-changes",
      description: "Review: review:security",
      prompt: SCRIPT,
      totalTokens: 312000,
      toolUses: 87,
      workflowProgress: progress(WF_PHASES, runningAgents),
    },
  }),
];

// ── 2 · 已完成 ────────────────────────────────────────────────────────────

const doneAgents: Agent[] = [
  { label: "review:bugs", phase: 1, state: "done", tokens: 48000, toolCalls: 14, durationMs: 130000, queuedAt: T0, startedAt: T0, lastProgressAt: T0 + 130000, promptPreview: "Review the diff for correctness bugs. Report findings as JSON.", resultPreview: "3 findings: off-by-one in pager, missing await, unchecked null" },
  { label: "review:perf", phase: 1, state: "done", tokens: 39000, toolCalls: 11, durationMs: 108000, queuedAt: T0, startedAt: T0, lastProgressAt: T0 + 108000, resultPreview: "1 finding: N+1 query in list view" },
  { label: "review:security", phase: 1, state: "done", tokens: 44000, toolCalls: 12, durationMs: 122000, queuedAt: T0, startedAt: T0, lastProgressAt: T0 + 122000 },
  { label: "review:tests", phase: 1, state: "done", tokens: 36000, toolCalls: 9, durationMs: 99000, queuedAt: T0, startedAt: T0, lastProgressAt: T0 + 99000 },
  { label: "verify:auth.ts", phase: 2, state: "done", model: "claude-haiku-4-5-20251001", tokens: 31000, toolCalls: 6, durationMs: 80000, queuedAt: T0 + 130000, startedAt: T0 + 130000, lastProgressAt: T0 + 210000 },
  { label: "verify:db.ts", phase: 2, state: "done", model: "claude-haiku-4-5-20251001", attempt: 2, tokens: 29000, toolCalls: 7, durationMs: 118000, queuedAt: T0 + 130000, startedAt: T0 + 131000, lastProgressAt: T0 + 249000 },
  { label: "verify:api.ts", phase: 2, state: "done", model: "claude-haiku-4-5-20251001", tokens: 27000, toolCalls: 5, durationMs: 65000, queuedAt: T0 + 108000, startedAt: T0 + 108000, lastProgressAt: T0 + 173000 },
  { label: "verify:ui.ts", phase: 2, state: "done", model: "claude-haiku-4-5-20251001", tokens: 24000, toolCalls: 4, durationMs: 58000, queuedAt: T0 + 210000, startedAt: T0 + 210000, lastProgressAt: T0 + 268000 },
  { label: "verify:cli.ts", phase: 2, state: "done", model: "claude-haiku-4-5-20251001", tokens: 26000, toolCalls: 6, durationMs: 72000, queuedAt: T0 + 173000, startedAt: T0 + 173000, lastProgressAt: T0 + 245000 },
  { label: "verify:docs.ts", phase: 2, state: "done", model: "claude-haiku-4-5-20251001", tokens: 19000, toolCalls: 3, durationMs: 44000, queuedAt: T0 + 221000, startedAt: T0 + 221000, lastProgressAt: T0 + 265000 },
  { label: "synthesize:report", phase: 3, state: "done", tokens: 18000, toolCalls: 2, durationMs: 41000, queuedAt: T0 + 268000, startedAt: T0 + 268000, lastProgressAt: T0 + 309000, resultPreview: "4 confirmed findings, report written to out/review.md" },
];

const completedCalls: ToolCall[] = [
  call({ id: "c1", name: "Read", input: { file_path: "/repo/docs/events.md" } }),
  call({
    id: "c2",
    name: "Workflow",
    durationMs: 298000,
    endedAt: T0 + 298000,
    input: { script: SCRIPT },
    output: '{"confirmed":4}',
    agent: {
      taskType: "local_workflow",
      taskId: "wl2zl75gq",
      phase: "completed",
      status: "completed",
      workflowName: "review-changes",
      prompt: SCRIPT,
      summary: 'Dynamic workflow "review-changes" completed',
      totalTokens: 412000,
      toolUses: 106,
      durationMs: 298000,
      workflowProgress: progress(WF_PHASES, doneAgents),
    },
  }),
];

// ── 3 · 已失败 ────────────────────────────────────────────────────────────

const failedAgents: Agent[] = doneAgents.map((a) =>
  a.label === "review:security"
    ? { ...a, state: "failed", attempt: 2, tokens: 22000, durationMs: 72000, resultPreview: "Error: agent exited with code 1" }
    : a.label === "synthesize:report"
      ? { ...a, state: "queued", tokens: undefined, toolCalls: undefined, durationMs: undefined, resultPreview: undefined }
      : a,
);

const failedCalls: ToolCall[] = [
  call({
    id: "f1",
    name: "Workflow",
    durationMs: 361000,
    endedAt: T0 + 361000,
    input: { script: SCRIPT },
    output: "workflow failed: review:security exited with code 1",
    agent: {
      taskType: "local_workflow",
      taskId: "wl2zl75gq",
      phase: "completed",
      status: "failed",
      workflowName: "review-changes",
      prompt: SCRIPT,
      summary: 'Dynamic workflow "review-changes" failed',
      totalTokens: 388000,
      toolUses: 94,
      durationMs: 361000,
      workflowProgress: progress(WF_PHASES, failedAgents),
    },
  }),
];

// ── 4 · 无阶段明细（旧 daemon / 秒挂的 resume） ───────────────────────────

const bareCalls: ToolCall[] = [
  call({
    id: "b1",
    name: "Workflow",
    durationMs: 133000,
    endedAt: T0 + 133000,
    input: { scriptPath: "/tmp/wf-resume.js" },
    output: "workflow finished (no progress snapshot)",
    agent: {
      taskType: "local_workflow",
      taskId: "wold01",
      workflowName: "review-changes",
      durationMs: 133000,
      summary: 'Dynamic workflow "review-changes" completed',
    },
  }),
];

// ── 5 · 53 个 agent 的规模 ────────────────────────────────────────────────

const scalePhases = [
  { index: 1, title: "Gen" },
  { index: 2, title: "Gate2" },
  { index: 3, title: "Gate3" },
  { index: 4, title: "Judge" },
];

const scaleAgents: Agent[] = [
  ...Array.from({ length: 5 }, (_, i) => ({
    label: `gen:batch-${String(i + 1).padStart(2, "0")}`,
    phase: 1,
    state: "done",
    tokens: 53000 + i * 2000,
    toolCalls: 4 + i,
    durationMs: 69000 + i * 5000,
    queuedAt: T0,
    startedAt: T0,
    lastProgressAt: T0 + 90000,
  })),
  ...Array.from({ length: 16 }, (_, i) => {
    const n = i + 1;
    const state = n <= 9 ? "done" : n <= 13 ? "start" : "queued";
    return {
      label: `gate2:q-${String(n).padStart(4, "0")}`,
      phase: 2,
      state,
      model: "claude-haiku-4-5-20251001",
      attempt: n === 3 ? 2 : undefined,
      tokens: state === "queued" ? undefined : 7000 + n * 200,
      toolCalls: state === "queued" ? undefined : 3 + (n % 4),
      durationMs: state === "done" ? 38000 + n * 1000 : undefined,
      queuedAt: T0 + 90000,
      startedAt: state === "queued" ? undefined : T0 + 90000 + n * 1000,
      lastProgressAt: state === "queued" ? undefined : T0 + 700000,
    };
  }),
  // 30 个一栏放不下、两栏也超 12 行 —— 尾部安静行该折起来。
  ...Array.from({ length: 30 }, (_, i) => {
    const n = i + 1;
    return {
      label: `gate3:q-${String(n).padStart(4, "0")}`,
      phase: 3,
      state: n === 1 ? "start" : "queued",
      model: "claude-haiku-4-5-20251001",
      tokens: n === 1 ? 4200 : undefined,
      queuedAt: T0 + 700000,
      startedAt: n === 1 ? T0 + 700000 : undefined,
      lastProgressAt: n === 1 ? T0 + 740000 : undefined,
    };
  }),
  ...Array.from({ length: 2 }, (_, i) => ({
    label: `judge:q-${String(i + 1).padStart(4, "0")}`,
    phase: 4,
    state: "queued",
    queuedAt: T0 + 700000,
  })),
];

const scaleCalls: ToolCall[] = [
  call({
    id: "s1",
    name: "Workflow",
    status: "running",
    durationMs: null,
    endedAt: null,
    startedAt: now - 1094000,
    input: { script: SCRIPT },
    agent: {
      taskType: "local_workflow",
      taskId: "wkbeval01",
      phase: "progress",
      workflowName: "kb-eval-afs-question-gen",
      description: "Gate2: gate2:q-0012",
      prompt: SCRIPT,
      totalTokens: 2400000,
      toolUses: 612,
      workflowProgress: progress(scalePhases, scaleAgents),
    },
  }),
];

// ── 6 · P1 行语言：普通行 + 子 Agent + 长跑 Bash + 失败行同框 ─────────────

const p1Calls: ToolCall[] = [
  call({ id: "p1", name: "Read", input: { file_path: "/repo/lib/tool-tree.ts" } }),
  call({ id: "p2", name: "Read", input: { file_path: "/repo/lib/types.ts" } }),
  call({ id: "p3", name: "Grep", input: { pattern: "workflow_progress", path: "/repo/lib" } }),
  call({
    id: "p4",
    name: "Edit",
    input: {
      file_path: "/repo/components/tools/ToolRow.tsx",
      old_string: "const open = userOpen ?? rowAutoOpen(node, live);",
      new_string: "const open = userOpen ?? rowAutoOpen(node, live, currentTodo);",
    },
  }),
  call({
    id: "p5",
    name: "Agent",
    startedAt: T0 + 1000,
    endedAt: T0 + 61000,
    durationMs: 60000,
    input: { subagent_type: "Explore", description: "摸清渲染链路", prompt: "去查 components/tools 下 Workflow 行是怎么渲染的" },
    agent: {
      taskType: "local_agent",
      taskId: "a77x",
      subagentType: "Explore",
      description: "摸清渲染链路",
      totalTokens: 84000,
      toolUses: 2,
      durationMs: 60000,
      summary: "渲染链路：ToolTimeline → TimelineList → ToolRow → views/*；Workflow 表头就是那条工具行本身。",
    },
  }),
  call({ id: "p6", name: "Read", parentToolUseId: "p5", startedAt: T0 + 2000, input: { file_path: "/repo/components/tools/ToolRow.tsx" } }),
  call({ id: "p7", name: "Grep", parentToolUseId: "p5", startedAt: T0 + 3000, input: { pattern: "resolveToolView" } }),
  call({
    id: "p8",
    name: "Bash",
    startedAt: T0 + 62000,
    endedAt: T0 + 104000,
    durationMs: 42000,
    input: { command: "bun test", description: "跑测试" },
    output: "420 pass\n0 fail\nRan 420 tests across 55 files.",
    agent: { taskType: "local_bash", taskId: "b31", description: "跑测试", durationMs: 42000, summary: "跑测试" },
  }),
  call({
    id: "p9",
    name: "Bash",
    status: "error",
    startedAt: T0 + 105000,
    endedAt: T0 + 106000,
    durationMs: 900,
    input: { command: "bunx tsc --noEmit" },
    output: "components/tools/ToolRow.tsx(198,7): error TS2322: Type 'string' is not assignable.",
  }),
];

// ── SQL ───────────────────────────────────────────────────────────────────

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

type Fixture = { key: string; title: string; question: string; response: string; calls: ToolCall[]; streaming?: boolean };

const fixtures: Fixture[] = [
  { key: "running", title: "Workflow 运行中", question: "跑一轮 review", response: "我先看一下事件定义，然后跑一轮 review。", calls: runningCalls, streaming: true },
  { key: "completed", title: "Workflow 已完成", question: "跑一轮 review", response: "跑完了，四个确认发现都写进 out/review.md 了。", calls: completedCalls },
  { key: "failed", title: "Workflow 已失败", question: "跑一轮 review", response: "review:security 这一路挂了，重试一次仍然退出码 1。", calls: failedCalls },
  { key: "bare", title: "Workflow 无阶段明细", question: "resume 那个 workflow", response: "这次是 resume 跑的，daemon 没回进度快照。", calls: bareCalls },
  { key: "scale", title: "Workflow 53 个 agent", question: "跑 kb-eval", response: "53 个 agent 正在按阶段推进。", calls: scaleCalls, streaming: true },
  { key: "p1", title: "动线行语言", question: "改一下 ToolRow", response: "改完了，测试全绿，tsc 那条我马上修。", calls: p1Calls },
];

const lines: string[] = [];
for (const f of fixtures) {
  const session = `mv-wf-${f.key}-session`;
  const node = `mv-wf-${f.key}`;
  lines.push(
    `INSERT OR REPLACE INTO sessions (id,title,root_node_id,created_at,updated_at,context_mode,archived,require_approval,kind,title_source) VALUES (${q(session)},${q(f.title)},${q(node)},${T0},${T0 + 1000},'chat',0,0,'user','default');`,
    `INSERT OR REPLACE INTO nodes (id,session_id,parent_id,parent_anchor_text,question,response,status,sibling_index,created_at,read_at,pending_interaction_json,tool_calls_json) VALUES (${q(node)},${q(session)},NULL,NULL,${q(f.question)},${q(f.response)},${q(f.streaming ? "streaming" : "done")},0,${T0},NULL,NULL,${q(JSON.stringify(f.calls))});`,
  );
}
console.log(lines.join("\n"));
