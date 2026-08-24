import { describe, expect, it } from "bun:test";
import {
  buildToolTree,
  MIN_SEGMENT,
  nestedErrorCount,
  runningChain,
  segmentTimeline,
  type TimelineEntry,
} from "./tool-tree";
import type { ToolCall } from "./types";

// segmentTimeline / runningChain 是纯派生逻辑，直接构造 ToolCall 测。
// 走真实 CLI 流水线的回放测试在 scripts/test-tool-tree.ts。

let seq = 0;
function call(
  over: Partial<ToolCall> & Pick<ToolCall, "name">,
): ToolCall {
  seq++;
  return {
    id: over.id ?? `c${seq}`,
    input: {},
    output: null,
    stderr: null,
    status: "done",
    durationMs: 10,
    startedAt: seq,
    endedAt: seq + 1,
    ...over,
  };
}

const bash = (over: Partial<ToolCall> = {}) =>
  call({ name: "Bash", input: { command: "ls" }, ...over });

function shapes(entries: TimelineEntry[]): string[] {
  return entries.map((e) =>
    e.type === "segment" ? `seg(${e.nodes.length})` : e.node.call.name,
  );
}

function seg(calls: ToolCall[]): TimelineEntry[] {
  return segmentTimeline(buildToolTree(calls));
}

describe("segmentTimeline", () => {
  it("连续 ≥MIN_SEGMENT 个已完成普通工具压成一段", () => {
    const entries = seg([bash(), bash(), bash()]);
    expect(MIN_SEGMENT).toBe(3);
    expect(shapes(entries)).toEqual(["seg(3)"]);
  });

  it("不足 MIN_SEGMENT 的连跑保持逐行", () => {
    expect(shapes(seg([bash(), bash()]))).toEqual(["Bash", "Bash"]);
  });

  it("委派永不入段，且把连跑切开", () => {
    const entries = seg([
      bash(),
      bash(),
      bash(),
      call({ name: "Agent", agent: { taskType: "local_agent" } }),
      bash(),
    ]);
    expect(shapes(entries)).toEqual(["seg(3)", "Agent", "Bash"]);
  });

  it("长跑命令（local_bash）不入段", () => {
    const entries = seg([
      bash(),
      bash(),
      bash({ agent: { taskType: "local_bash", taskId: "bxx" } }),
      bash(),
    ]);
    expect(shapes(entries)).toEqual(["Bash", "Bash", "Bash", "Bash"]);
  });

  it("失败的调用不入段——chip 不许藏错", () => {
    const entries = seg([bash(), bash(), bash({ status: "error" }), bash(), bash()]);
    expect(shapes(entries)).toEqual(["Bash", "Bash", "Bash", "Bash", "Bash"]);
    const err = entries[2];
    expect(err.type === "node" && err.node.call.status).toBe("error");
  });

  it("正在跑的调用不入段——热尾巴留在外面", () => {
    const entries = seg([bash(), bash(), bash(), bash({ status: "running" })]);
    expect(shapes(entries)).toEqual(["seg(3)", "Bash"]);
  });

  it("TodoWrite 检查点把机械段切成章节", () => {
    const entries = seg([
      bash(),
      bash(),
      bash(),
      call({ name: "TodoWrite", input: { todos: [] } }),
      bash(),
      bash(),
      bash(),
    ]);
    expect(shapes(entries)).toEqual(["seg(3)", "TodoWrite", "seg(3)"]);
  });

  it("AskUserQuestion 是人机交互节拍，不入段", () => {
    const entries = seg([
      bash(),
      bash(),
      call({ name: "AskUserQuestion", input: { questions: [] } }),
      bash(),
      bash(),
    ]);
    expect(shapes(entries)).toEqual([
      "Bash",
      "Bash",
      "AskUserQuestion",
      "Bash",
      "Bash",
    ]);
  });

  it("时间顺序原样保留", () => {
    const entries = seg([
      bash({ id: "a" }),
      call({ id: "b", name: "Agent", agent: { taskType: "local_agent" } }),
      bash({ id: "c" }),
    ]);
    const ids = entries.flatMap((e) =>
      e.type === "segment" ? e.nodes.map((n) => n.call.id) : [e.node.call.id],
    );
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("空列表返回空", () => {
    expect(segmentTimeline([])).toEqual([]);
  });
});

describe("runningChain", () => {
  it("无运行节点 → 空链", () => {
    expect(runningChain(buildToolTree([bash()]))).toEqual([]);
  });

  it("顶层运行的普通工具就是链尾", () => {
    const chain = runningChain(buildToolTree([bash(), bash({ status: "running" })]));
    expect(chain.map((n) => n.call.status)).toEqual(["running"]);
  });

  it("穿透运行中的子 Agent 拿到它正在跑的调用", () => {
    const chain = runningChain(
      buildToolTree([
        call({
          id: "agent",
          name: "Agent",
          status: "running",
          agent: { taskType: "local_agent", subagentType: "Explore" },
        }),
        call({ id: "kid-done", name: "Read", parentToolUseId: "agent" }),
        call({
          id: "kid-run",
          name: "Bash",
          status: "running",
          parentToolUseId: "agent",
        }),
      ]),
    );
    expect(chain.map((n) => n.call.id)).toEqual(["agent", "kid-run"]);
  });

  it("并行运行时挑最新启动的分支", () => {
    const chain = runningChain(
      buildToolTree([
        call({ id: "a1", name: "Agent", status: "running", agent: { taskType: "local_agent" } }),
        call({ id: "a2", name: "Agent", status: "running", agent: { taskType: "local_agent" } }),
      ]),
    );
    expect(chain.map((n) => n.call.id)).toEqual(["a2"]);
  });
});

describe("nestedErrorCount", () => {
  it("上卷子树里的失败，不算自己", () => {
    const tree = buildToolTree([
      call({ id: "agent", name: "Agent", status: "error", agent: { taskType: "local_agent" } }),
      call({ id: "k1", name: "Bash", status: "error", parentToolUseId: "agent" }),
      call({ id: "k2", name: "Bash", parentToolUseId: "agent" }),
    ]);
    expect(nestedErrorCount(tree[0])).toBe(1);
  });
});
