import { describe, expect, test } from "bun:test";
import { composerStatusPills, runningBackgroundTasks } from "./composer-status";
import { contextUsageFor } from "./context-usage";
import type { TaskMeta, ToolCall } from "./types";

function call(id: string, status: ToolCall["status"], agent?: TaskMeta): ToolCall {
  return { id, name: "Bash", input: {}, output: null, stderr: null, status, durationMs: null, startedAt: 0, endedAt: null, agent };
}

const none = { count: 0, kinds: [] };

describe("runningBackgroundTasks", () => {
  test("只数带任务元信息、仍在跑的调用", () => {
    const calls = [
      call("plain", "running"),
      call("bash", "running", { taskType: "local_bash", phase: "progress" }),
      call("agentByPrefix", "running", { taskId: "a123" }),
      call("doneByPhase", "running", { taskType: "local_agent", phase: "completed" }),
      call("doneByStatus", "running", { taskType: "local_workflow", status: "failed" }),
      call("resultIn", "done", { taskType: "local_bash", phase: "progress" }),
    ];
    expect(runningBackgroundTasks(calls)).toEqual({ count: 2, kinds: ["local_bash", "local_agent"] });
  });
  test("空 / 未加载", () => {
    expect(runningBackgroundTasks(undefined)).toEqual(none);
  });
});

describe("composerStatusPills", () => {
  test("什么都没有 → 空（状态条不渲染）", () => {
    expect(composerStatusPills({ queue: { count: 0, status: "empty" }, context: null, background: none })).toEqual([]);
  });
  test("上下文低于门槛不出", () => {
    const pills = composerStatusPills({
      queue: { count: 0, status: "empty" },
      context: { tokens: 90_000, percent: 45, contextWindow: 200_000 },
      background: none,
    });
    expect(pills).toEqual([]);
  });
  test("排队 + 上下文 + 后台，顺序固定、色调随状态", () => {
    const pills = composerStatusPills({
      queue: { count: 2, status: "paused" },
      context: { tokens: 170_000, percent: 85, contextWindow: 200_000 },
      background: { count: 1, kinds: ["local_bash"] },
    });
    expect(pills.map((p) => [p.kind, p.label, p.tone])).toEqual([
      ["queue", "已暂停 · 排队 2", "warn"],
      ["context", "上下文 85%", "warn"],
      ["background", "命令 1 运行中", "neutral"],
    ]);
  });
  test("自动发送中的排队是中性色；混合后台任务统称", () => {
    const pills = composerStatusPills({
      queue: { count: 1, status: "auto" },
      context: { tokens: 110_000, percent: 55, contextWindow: 200_000 },
      background: { count: 2, kinds: ["local_bash", "local_agent"] },
    });
    expect(pills.map((p) => [p.label, p.tone])).toEqual([
      ["排队 1", "neutral"],
      ["上下文 55%", "neutral"],
      ["后台任务 2 运行中", "neutral"],
    ]);
  });
});

describe("contextUsageFor", () => {
  const mk = (id: string, parentId: string | null, contextTokens: number) => ({
    id,
    parentId,
    createdAt: 0,
    tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, contextTokens },
  });
  test("沿父链取最近上报的轮次并按窗口算百分比", () => {
    const nodes = { a: mk("a", null, 120_000), b: mk("b", "a", 0) };
    expect(contextUsageFor("b", nodes, 200_000)).toEqual({ tokens: 120_000, percent: 60, contextWindow: 200_000 });
  });
  test("封顶 100%", () => {
    expect(contextUsageFor("a", { a: mk("a", null, 300_000) }, 200_000)?.percent).toBe(100);
  });
  test("无节点 / 无数据 / 窗口无效 → null", () => {
    expect(contextUsageFor(null, {}, 200_000)).toBeNull();
    expect(contextUsageFor("a", { a: mk("a", null, 0) }, 200_000)).toBeNull();
    expect(contextUsageFor("a", { a: mk("a", null, 10) }, 0)).toBeNull();
  });
});
