"use client";
import { Check, ShieldCheck } from "lucide-react";
import { describeToolKey, scopeLabel } from "@/lib/approval-rules";
import { Icon, Pill, Spinner, StatusDot } from "@/components/ui";
import { formatDuration } from "@/lib/format-duration";
import { formatTokens } from "@/lib/format-tokens";
import { delegatedStepCount, isFailed, type ToolNode } from "@/lib/tool-tree";
import { hasValidWorkflowProgress, workflowStatusOf } from "@/lib/workflow-view";

// 行尾的那一段（统计 · 状态），普通行与 Workflow 表头共用。
//
// 单独成文件是为了打断环：ToolRow 渲染 WorkflowHead（views/WorkflowChrome），
// 两边都要用这里的零件。一套状态表达 —— 运行（components/ui 的 Spinner）/
// 完成（淡灰对勾）/ 失败（红点）/ 中断（中性胶囊）—— 只在这里定义一次。

/**
 * 行尾：嵌套失败 · 弱色统计 · 状态。所有行（含 Workflow 表头）共用这一段，
 * 状态永远贴右、统计永远在它左边，一个数只在这里出现一次。
 */
export function RowTail({
  node,
  stat,
  nestedErrors,
  status,
}: {
  node: ToolNode;
  stat: string;
  nestedErrors: number;
  status: RowStatus;
}) {
  const approval = node.call.approval;
  return (
    <>
      {approval && (
        // 审批三档作用域：按已授权规则自动放行的调用要留痕，不能和人手点的混在一起。
        <Pill
          tone="neutral"
          data-tool-approval={approval.scope}
          className="shrink-0"
          title={`没有弹卡：命中「${scopeLabel(approval.scope)}」规则 · ${describeToolKey(approval.toolKey)}（可在 设置 › 已授权规则 撤销）`}
        >
          <Icon icon={ShieldCheck} size="sm" />
          按规则允许
        </Pill>
      )}
      {nestedErrors > 0 && (
        // 收着的委派行也得把肚子里的失败招出来 —— 折叠不是藏错的理由。
        <span className="shrink-0 inline-flex items-center gap-1 text-nano text-danger-ink">
          <StatusDot tone="danger" />
          {nestedErrors} 失败
        </span>
      )}
      {stat && (
        <span
          className="shrink-0 font-mono text-nano tabular-nums text-ink-faint"
          title={statTitle(node)}
        >
          {stat}
        </span>
      )}
      <StatusPill status={status} />
    </>
  );
}

/** 一套状态，所有行共用（普通工具、子 Agent、Workflow）。 */
export type RowStatus = "running" | "interrupted" | "failed" | "done";

export function rowStatus(node: ToolNode, live: boolean): RowStatus {
  // The turn ended while this call was still open — aborted, or the run
  // died. Showing "运行中" forever is worse than admitting we lost it.
  if (node.running) return live ? "running" : "interrupted";
  if (isFailed(node)) return "failed";
  // Workflow 还多一条：任何一个 agent 挂了，全绿的对勾就是谎
  // （workflowStatusOf 的口径，快照不合规时它不会被调用）。
  if (
    node.kind === "workflow" &&
    hasValidWorkflowProgress(node) &&
    workflowStatusOf(node, live) === "failed"
  ) {
    return "failed";
  }
  return "done";
}

/**
 * 行尾状态位 —— 安静是默认值。
 *
 * 跑完只挂一枚淡灰对勾（一屏 40 行绿胶囊等于没有胶囊）；运行中是共用的
 * Spinner；失败是红点 + 「失败」二字（醒目，但不喊）；turn 已结束却仍开着
 * 的调用承认「已中断」。Workflow 与普通行同一套，不再另挂彩色胶囊。
 */
export function StatusPill({ status }: { status: RowStatus }) {
  switch (status) {
    case "running":
      return <Spinner size="sm" label="运行中" />;
    case "interrupted":
      return (
        <Pill tone="neutral" className="shrink-0">
          已中断
        </Pill>
      );
    case "failed":
      return (
        <span className="shrink-0 inline-flex items-center gap-1 text-nano font-medium text-danger-ink">
          <StatusDot tone="danger" />
          失败
        </span>
      );
    default:
      return (
        <Icon icon={Check} size="sm" className="text-ink-faint" />
      );
  }
}

// "5 步 · 12.4k · 8s" —— 行尾唯一的统计。「步」和面板表头、段落 chip 同一个
// 单位、同一个口径（delegatedStepCount：有子调用行就数子调用）；Workflow 的
// 进度由表头的 done/total 说，这里不再数步。
export function statLine(node: ToolNode, elapsed: number | null): string {
  const parts: string[] = [];
  if (node.kind !== "tool" && node.kind !== "workflow") {
    const steps = delegatedStepCount(node);
    if (steps > 0) parts.push(`${steps} 步`);
  }
  if (node.kind !== "tool" && node.meta.totalTokens) {
    parts.push(formatTokens(node.meta.totalTokens));
  }
  const ms = elapsed ?? node.call.durationMs ?? node.meta.durationMs ?? null;
  if (ms !== null) parts.push(formatDuration(ms));
  return parts.join(" · ");
}

// 悬停补全：CLI 自报的调用次数口径和「步」不同（它连子 Agent 内部、没浮出
// tool_use 的调用都算），放在这里给要对账的人看，不占行面。
function statTitle(node: ToolNode): string | undefined {
  const parts: string[] = [];
  if (node.meta.toolUses) parts.push(`CLI 计 ${node.meta.toolUses} 次工具调用`);
  if (node.meta.totalTokens) parts.push(`${node.meta.totalTokens.toLocaleString()} tokens`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
