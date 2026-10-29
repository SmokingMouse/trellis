import type { QueueStatus } from "./composer-queue";
import type { ContextUsage } from "./context-usage";
import { taskKindOf } from "./tool-tree";
import type { TaskKind, ToolCall } from "./types";

// 输入框上方的紧凑状态条（components/ComposerStatusBar.tsx）：把排队、上下文用量、
// 本轮后台任务合成一行 pill。纯函数：只决定「出哪些 pill、什么文案、什么色调」，
// 交互（点开排队列表 / 上下文详情）在组件里。一个都没有 → 空数组，状态条不渲染、不占高度。

/** 上下文用量到这个百分比才进状态条（与 Header 详情里「开新话题」的门槛一致）。 */
export const CONTEXT_PILL_MIN_PERCENT = 50;
/** 到这个百分比换 warn 色（与 Header 上下文条一致）。 */
export const CONTEXT_WARN_PERCENT = 80;

export type BackgroundTasks = { count: number; kinds: TaskKind[] };

const TASK_DONE_STATUS = new Set(["completed", "failed", "killed", "stopped", "cancelled", "canceled", "error"]);

/**
 * 一轮里仍在跑的后台任务（子 Agent / 长跑 Bash / Workflow）：带任务元信息、
 * 且还没进入完成阶段。只看该轮的 toolCalls——流式节点的 toolCalls 随事件实时进 store。
 */
export function runningBackgroundTasks(toolCalls: readonly ToolCall[] | undefined): BackgroundTasks {
  const kinds: TaskKind[] = [];
  for (const call of toolCalls ?? []) {
    const kind = taskKindOf(call.agent);
    if (!kind) continue;
    const meta = call.agent!;
    if (meta.phase === "completed") continue;
    if (meta.status && TASK_DONE_STATUS.has(meta.status)) continue;
    // 长跑 Bash 的 tool_result 落地 = 命令结束；子 Agent / Workflow 的 tool_result
    // 也是在任务收尾时才回来。出错同理。
    if (call.status !== "running") continue;
    kinds.push(kind);
  }
  return { count: kinds.length, kinds };
}

const KIND_LABEL: Record<TaskKind, string> = {
  local_agent: "子 Agent",
  local_bash: "命令",
  local_workflow: "Workflow",
};

export type ComposerStatusPill =
  | { kind: "queue"; label: string; ariaLabel: string; tone: "neutral" | "warn"; count: number }
  | { kind: "context"; label: string; ariaLabel: string; tone: "neutral" | "warn"; percent: number }
  | { kind: "background"; label: string; ariaLabel: string; tone: "neutral"; count: number };

export function formatContextPercent(percent: number): string {
  return percent < 10 ? percent.toFixed(1) : String(Math.round(percent));
}

export function composerStatusPills(input: {
  queue: { count: number; status: QueueStatus };
  context: ContextUsage | null;
  background: BackgroundTasks;
}): ComposerStatusPill[] {
  const pills: ComposerStatusPill[] = [];
  const { queue, context, background } = input;
  if (queue.count > 0) {
    const stalled = queue.status === "paused" || queue.status === "waiting";
    const prefix = queue.status === "paused" ? "已暂停 · " : "";
    pills.push({
      kind: "queue",
      label: `${prefix}排队 ${queue.count}`,
      ariaLabel: `${queue.count} 条排队消息${queue.status === "paused" ? "（已暂停）" : queue.status === "waiting" ? "（等待中）" : ""}，点击查看列表`,
      tone: stalled ? "warn" : "neutral",
      count: queue.count,
    });
  }
  if (context && context.percent >= CONTEXT_PILL_MIN_PERCENT) {
    const shown = formatContextPercent(context.percent);
    pills.push({
      kind: "context",
      label: `上下文 ${shown}%`,
      ariaLabel: `上下文占用 ${shown}%，点击查看详情`,
      tone: context.percent >= CONTEXT_WARN_PERCENT ? "warn" : "neutral",
      percent: context.percent,
    });
  }
  if (background.count > 0) {
    const distinct = [...new Set(background.kinds)];
    const what = distinct.length === 1 ? KIND_LABEL[distinct[0]] : "后台任务";
    pills.push({
      kind: "background",
      label: `${what} ${background.count} 运行中`,
      ariaLabel: `本轮有 ${background.count} 个${what}在后台运行`,
      tone: "neutral",
      count: background.count,
    });
  }
  return pills;
}
