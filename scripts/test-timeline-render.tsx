// Render smoke test for the tool timeline.
//
// test-tool-tree.ts proves the *data* comes out right; this proves the
// components actually render it. Catches the failure mode a pure-data test
// can't: a view that throws on a payload shape, or a canRender guard that
// lets a blank card through.
//
// Run:  bun scripts/test-timeline-render.tsx

import { renderToStaticMarkup } from "react-dom/server";
import { buildToolTree, type ToolNode } from "@/lib/tool-tree";
import type { ToolCall } from "@/lib/types";
import { ToolTimeline } from "@/components/tools/ToolTimeline";
import { rowAutoOpen, TimelineList, ToolRow } from "@/components/tools/ToolRow";

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

const base = (
  over: Partial<ToolCall> & Pick<ToolCall, "id" | "name">,
): ToolCall => ({
  input: {},
  output: null,
  stderr: null,
  status: "done",
  durationMs: 12,
  startedAt: Number(over.id) || 1,
  endedAt: 2,
  ...over,
});

function render(calls: ToolCall[], live = false): string {
  return renderToStaticMarkup(
    <ToolTimeline nodeId="test-node" toolCalls={calls} live={live} />,
  );
}

function nodeOf(calls: ToolCall[]): ToolNode {
  return buildToolTree(calls)[0];
}

// A collapsed row keeps its body out of the DOM and a static render can't
// click, so body assertions go through a single row rendered on its own.
function renderRow(calls: ToolCall[], live = false): string {
  return renderToStaticMarkup(<ToolRow node={nodeOf(calls)} live={live} />);
}

// ── 收起态的行头 ─────────────────────────────────────────────────────────
console.log("\n── 收起态：一行说清一步");
{
  const html = render(
    [
      base({ id: "1", name: "Bash", input: { command: "git status" }, output: "clean" }),
      base({
        id: "3",
        name: "Bash",
        input: { command: "sleep 12" },
        output: "(Bash completed with no output)",
        agent: { taskType: "local_bash", taskId: "bxx", summary: "Sleep 12 seconds" },
      }),
      base({
        id: "4",
        name: "Agent",
        input: { subagent_type: "Explore", description: "摸清渲染链路", prompt: "去查" },
        agent: { taskType: "local_agent", summary: "查完了：见报告" },
      }),
      base({ id: "5", name: "Read", parentToolUseId: "4", input: { file_path: "/repo/x.ts" } }),
      base({ id: "8", name: "mcp__linear__create_issue", input: { title: "x" } }),
      base({ id: "9", name: "TotallyUnknownTool", input: { weird: [1, 2, 3] } }),
    ],
    true,
  );

  check("Bash 命令出现在摘要行", html.includes("git status"));
  check("子 Agent 标签用 subagent_type", html.includes("Explore"));
  check("长跑命令挂 ⏱ 而不是 🤖", html.includes("⏱"));
  check("只有真子 Agent 挂 🤖", html.split("🤖").length - 1 === 1, html.split("🤖").length - 1);
  check("MCP 工具有像样的标题", html.includes("MCP linear"));
  check("未知工具不炸且有兜底摘要", html.includes("TotallyUnknownTool"));
  check("子调用不在顶层重复出现", html.split("/repo/x.ts").length - 1 <= 1, html.split("/repo/x.ts").length - 1);
  check("统计行报出子 Agent 数", render([
    base({ id: "4", name: "Agent", agent: { taskType: "local_agent" } }),
  ]).includes("1 子 Agent"));
}

// ── 展开后的 body ────────────────────────────────────────────────────────
console.log("\n── 展开态：每种 body 都渲染得出来");
{
  const diff = renderRow([
    base({
      id: "1",
      name: "Edit",
      input: {
        file_path: "/repo/a.ts",
        old_string: "const a = 1;\nconst b = 2;",
        new_string: "const a = 1;\nconst b = 3;",
      },
    }),
  ]);
  check("Edit 渲染成 diff（+/− 计数）", diff.includes("+1") && diff.includes("−1"));
  check("diff 里能看见改后那行", diff.includes("const b = 3;"));
  check("diff 保留未改的上下文", diff.includes("const a = 1;"));

  const bash = renderRow([
    base({
      id: "1",
      name: "Bash",
      status: "error",
      input: { command: "sleep 12" },
      output: "(Bash completed with no output)",
      agent: { taskType: "local_bash", taskId: "bxx", summary: "Sleep 12 seconds" },
    }),
  ]);
  check("长跑命令的输出可见", bash.includes("Bash completed with no output"));
  check("长跑命令没有「它交回的报告」区", !bash.includes("它交回的报告"));

  const sub = renderRow(
    [
      base({
        id: "1",
        name: "Agent",
        status: "running",
        input: { subagent_type: "Explore", description: "摸清渲染链路", prompt: "去查一下" },
        agent: { taskType: "local_agent", summary: "查完了：见报告" },
      }),
      base({ id: "2", name: "Read", parentToolUseId: "1", input: { file_path: "/repo/x.ts" } }),
    ],
    true,
  );
  check("子 Agent 的报告渲染出来", sub.includes("查完了"));
  check("子调用嵌在子 Agent 里", sub.includes("它的工具链"));
  check("子调用本身渲染出来", sub.includes("x.ts"));
  check("交给它的任务可见", sub.includes("去查一下"));

  const wf = renderRow([
    base({
      id: "1",
      name: "Workflow",
      input: { script: "export const meta = {}" },
      agent: {
        taskType: "local_workflow",
        workflowName: "probe-wf",
        workflowProgress: [
          { type: "workflow_phase", index: 1, title: "Alpha" },
          { type: "workflow_phase", index: 2, title: "Beta" },
          {
            type: "workflow_agent",
            index: 1,
            label: "alpha-1",
            phaseIndex: 1,
            phaseTitle: "Alpha",
            state: "done",
            tokens: 25175,
            durationMs: 8855,
            resultPreview: "ALPHA_OK",
          },
          // 还没跑完的 agent 让 Alpha 保持活跃 —— 活跃 phase 才铺开 agent 行。
          {
            type: "workflow_agent",
            index: 2,
            label: "alpha-2",
            phaseIndex: 1,
            phaseTitle: "Alpha",
            state: "start",
          },
        ],
      },
    }),
  ]);
  check("Workflow 渲染出 phase 树", wf.includes("Alpha") && wf.includes("Beta") && wf.includes("2 阶段"));
  check("活跃 phase 铺开 agent 行", wf.includes("alpha-1") && wf.includes("alpha-2"));
  check("Workflow agent 的结果预览可见", wf.includes("ALPHA_OK"));
  check("phase 头部带完成计数", wf.includes("1/2"));
  check("统计行报出运行中数量", wf.includes("1 运行中"));
  check("Workflow 脚本收进折叠区而不是摘要行", wf.includes("工作流脚本"));

  // 全部跑完的 phase 收成一行标题 + 计数 —— agent 行是冷数据，点击才回来。
  const wfDone = renderRow([
    base({
      id: "1",
      name: "Workflow",
      input: { script: "export const meta = {}" },
      agent: {
        taskType: "local_workflow",
        workflowName: "probe-wf",
        workflowProgress: [
          { type: "workflow_phase", index: 1, title: "Alpha" },
          {
            type: "workflow_agent",
            index: 1,
            label: "alpha-1",
            phaseIndex: 1,
            phaseTitle: "Alpha",
            state: "done",
            resultPreview: "ALPHA_OK",
          },
        ],
      },
    }),
  ]);
  check(
    "跑完的 phase 收成一行（agent 行不进 DOM）",
    wfDone.includes("Alpha") && wfDone.includes("1/1") && !wfDone.includes("alpha-1"),
  );

  const todo = renderRow([
    base({
      id: "1",
      name: "TodoWrite",
      input: {
        todos: [
          { content: "写完", status: "completed" },
          { content: "验证", status: "in_progress", activeForm: "正在验证" },
        ],
      },
    }),
  ]);
  check("TodoWrite 渲染成清单", todo.includes("1 / 2 完成"));
  check("进行中的项用 activeForm", todo.includes("正在验证"));
}

// ── 降级与铁律 ───────────────────────────────────────────────────────────
console.log("\n── 降级与铁律");
{
  check("空列表不渲染任何东西", render([]) === "");

  // canRender 说不行 → 必须落回 RawView，不能出空卡。
  const brokenEdit = renderRow([
    base({ id: "1", name: "Edit", input: { file_path: "/x", old_string: 42 } }),
  ]);
  check("Edit 输入不合规时降级到原始 JSON", brokenEdit.includes("old_string"));

  const emptyWorkflow = renderRow([
    base({
      id: "1",
      name: "Workflow",
      input: { scriptPath: "/tmp/x.js" },
      agent: { taskType: "local_workflow" },
    }),
  ]);
  check("没有进度快照的 Workflow 降级到原始视图", emptyWorkflow.includes("scriptPath"));

  const brokenTodo = renderRow([
    base({ id: "1", name: "TodoWrite", input: { todos: "not-an-array" } }),
  ]);
  check("TodoWrite 输入不合规时降级", brokenTodo.includes("not-an-array"));

  // 失败永不隐藏，哪怕 resultPolicy 写着 hideOnSuccess。
  const failedRead = renderRow([
    base({
      id: "1",
      name: "Read",
      status: "error",
      input: { file_path: "/nope" },
      output: "ENOENT: no such file",
    }),
  ]);
  check("失败的 Read 仍然显示输出（resultPolicy 拦不住错误）", failedRead.includes("ENOENT"));
  check("失败的行打上失败徽章", failedRead.includes("失败"));

  const okRead = renderRow([
    base({ id: "1", name: "Read", input: { file_path: "/x" }, output: "整个文件内容".repeat(50) }),
  ]);
  check("成功的 Read 不把文件正文倒进时间线", !okRead.includes("整个文件内容整个文件内容"));

  // stderr 不受 resultPolicy 管：Read 配的是 hideOnSuccess，失败时输出和
  // stderr 都得原样露出来。
  const withStderr = renderRow([
    base({
      id: "1",
      name: "Read",
      status: "error",
      input: { file_path: "/x" },
      output: "",
      stderr: "command not found",
    }),
  ]);
  check("stderr 不被 resultPolicy 吞掉", withStderr.includes("command not found"));
}

// ── 冷热分段 ─────────────────────────────────────────────────────────────
// 本次重排的核心：已完成的普通工具连跑折成一枚段落 chip（冷），委派骨架、
// 失败、正在跑的行、当前计划常驻（热）。
console.log("\n── 冷热分段：历史折叠，热区常驻");
{
  const doneRun = (n: number, offset = 0): ToolCall[] =>
    Array.from({ length: n }, (_, i) =>
      base(
        i % 2
          ? { id: String(offset + i + 1), name: "Read", input: { file_path: `/repo/f${offset + i}.ts` } }
          : { id: String(offset + i + 1), name: "Bash", input: { command: `cmd-${offset + i}` } },
      ),
    );
  const renderList = (calls: ToolCall[], live: boolean) =>
    renderToStaticMarkup(
      <TimelineList nodes={buildToolTree(calls)} live={live} />,
    );

  const liveHtml = renderList(
    [
      ...doneRun(3),
      base({ id: "9", name: "Bash", status: "running", input: { command: "npm test" } }),
    ],
    true,
  );
  check("已完成连跑折成段落 chip", liveHtml.includes("3 步"));
  check("chip 点名工具与次数", liveHtml.includes("Bash ×2") && liveHtml.includes("Read"));
  check("段内明细不进 DOM（冷数据点击才展开）", !liveHtml.includes("cmd-0"));
  check("正在跑的调用不被吞进段里", liveHtml.includes("npm test"));

  check(
    "非流式的唯一段落直接铺行（chip 只会复读计数）",
    renderList(doneRun(3), false).includes("cmd-0"),
  );

  const mixed = renderList(
    [
      ...doneRun(3),
      base({
        id: "20",
        name: "Agent",
        input: { subagent_type: "Explore", description: "查一下" },
        agent: { taskType: "local_agent" },
      }),
      ...doneRun(3, 30),
    ],
    false,
  );
  check("混合骨架保留委派行", mixed.includes("Explore"));
  check("混合骨架里的段落仍是 chip", (mixed.match(/3 步/g) ?? []).length === 2);

  const withErr = renderList(
    [
      ...doneRun(2),
      base({ id: "40", name: "Bash", status: "error", input: { command: "boom" }, output: "exit 1" }),
      ...doneRun(2, 50),
    ],
    false,
  );
  check("失败的行不被段落吞掉", withErr.includes("boom"));
  check("失败的行自动展开 body", withErr.includes("exit 1"));

  const todos = renderList(
    [
      base({
        id: "t1",
        name: "TodoWrite",
        input: { todos: [{ content: "旧的第一版计划条目", status: "pending" }] },
      }),
      base({
        id: "t2",
        name: "TodoWrite",
        input: {
          todos: [
            { content: "当前计划条目", status: "in_progress", activeForm: "正在推进当前计划" },
          ],
        },
      }),
    ],
    true,
  );
  check("最后一个 TodoWrite 是当前计划，live 也展开", todos.includes("正在推进当前计划"));
  check("旧 TodoWrite 收起成一行", !todos.includes("旧的第一版计划条目"));

  // header 面包屑：收着的面板也能看到最深运行链（agent › 它正在跑的工具）。
  const crumb = render(
    [
      base({
        id: "1",
        name: "Agent",
        status: "running",
        input: { subagent_type: "Explore", description: "查渲染链路" },
        agent: { taskType: "local_agent", lastToolName: "Grep" },
      }),
    ],
    true,
  );
  check("header 面包屑露出运行链", crumb.includes("Explore") && crumb.includes("Grep"));
  check("面包屑用 › 连接", crumb.includes("›"));
}

// ── 展开规则 ─────────────────────────────────────────────────────────────
console.log("\n── 展开规则");
{
  const plain = nodeOf([base({ id: "1", name: "Bash", input: { command: "ls" } })]);
  const failed = nodeOf([base({ id: "1", name: "Bash", status: "error", input: { command: "ls" } })]);
  const edit = nodeOf([
    base({ id: "1", name: "Edit", input: { file_path: "/x", old_string: "a", new_string: "b" } }),
  ]);
  const todo = nodeOf([
    base({ id: "1", name: "TodoWrite", input: { todos: [] } }),
  ]);
  const runningSub = nodeOf([
    base({ id: "1", name: "Agent", status: "running", agent: { taskType: "local_agent" } }),
  ]);
  const runningBash = nodeOf([base({ id: "1", name: "Bash", status: "running" })]);

  check("普通工具默认收起", !rowAutoOpen(plain, false));
  check("失败的行默认展开", rowAutoOpen(failed, false));
  check("失败的行即使不在流式里也展开", rowAutoOpen(failed, false) && rowAutoOpen(failed, true));
  check("Edit 默认展开（body 就是内容）", rowAutoOpen(edit, false));
  check("live 期间已完成的 Edit 不再摊开（冷数据让位）", !rowAutoOpen(edit, true));
  check("当前 TodoWrite live 期间保持展开", rowAutoOpen(todo, true, true));
  check("非当前 TodoWrite live 期间收起", !rowAutoOpen(todo, true, false));
  check("流式中正在跑的子 Agent 默认展开", rowAutoOpen(runningSub, true));
  check("非流式（已中断）的子 Agent 不展开", !rowAutoOpen(runningSub, false));
  check("流式中的普通工具不展开（否则每一步都炸开）", !rowAutoOpen(runningBash, true));

  const calls = [base({ id: "1", name: "Bash", input: { command: "ls" }, output: "a\nb" })];
  check("面板：跑完默认收起", !render(calls, false).includes("输入"));
  check("面板：流式时默认展开到行级", render(calls, true).includes("ls"));
  check("面板：收起态仍报出步数", render(calls, false).includes("1 步"));
}

console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
