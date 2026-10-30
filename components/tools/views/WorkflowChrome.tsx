"use client";
import { Spinner, ToolIcon } from "@/components/ui";
import type { ToolNode } from "@/lib/tool-tree";
import {
  AGENT_STATE_LABEL,
  buildWorkflowVM,
  type AgentState,
  type WorkflowPhaseVM,
  type WorkflowStatus,
} from "@/lib/workflow-view";
import { RowTail, rowStatus, statLine } from "../RowStatus";

// Workflow 卡的「外壳」：表头那一行、进度轨、agent 状态字形。
//
// 单独成文件是为了打断环：表头由 ToolRow 渲染（Workflow 就是动线里那条工具
// 行，不另起卡片），面板由 views/WorkflowView 渲染，两边都要用这里的零件。

// ── 字形 ──────────────────────────────────────────────────────────────────
//
// 运行中的转圈用 components/ui 的 Spinner —— 全站一个，不再自画一枚。

const GLYPH: Record<Exclude<AgentState, "running">, string[]> = {
  // ✓ / 时钟 / ✗ / 禁止号，都画在同一个 r=9 的圆里，行首因此永远对齐。
  done: ["m8.5 12 2.5 2.5 4.5-4.5"],
  queued: ["M12 7v5h3.5"],
  failed: ["m14.5 9.5-5 5", "m9.5 9.5 5 5"],
  killed: ["m5.6 5.6 12.8 12.8"],
};

const GLYPH_COLOR: Record<AgentState, string> = {
  done: "text-positive-ink",
  running: "text-ink-muted",
  queued: "text-ink-faint",
  failed: "text-danger-ink",
  killed: "text-ink-faint",
};

export function AgentStateIcon({ state }: { state: AgentState }) {
  return (
    <span
      className={`inline-flex items-center justify-center ${GLYPH_COLOR[state]}`}
    >
      {state === "running" ? (
        <Spinner size="sm" label={null} className="w-3 h-3 text-current" />
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-3 h-3"
          aria-hidden
        >
          <circle cx="12" cy="12" r="9" />
          {GLYPH[state].map((d) => (
            <path key={d} d={d} />
          ))}
        </svg>
      )}
      <span className="sr-only">{AGENT_STATE_LABEL[state]}</span>
    </span>
  );
}

// ── 进度轨 ────────────────────────────────────────────────────────────────

const RAIL_ACCENT: Record<WorkflowStatus, string> = {
  running: "var(--ink)",
  completed: "var(--ink)",
  failed: "var(--danger)",
  killed: "var(--ink-faint)",
};

/** 点阵底 + 11px 刻度填充。刻度让「11 个里跑完 4 个」看得出粒度。 */
export function ProgressRail({
  percent,
  status,
  className = "",
}: {
  percent: number;
  status: WorkflowStatus;
  className?: string;
}) {
  return (
    <span
      className={`relative block shrink-0 w-[72px] max-w-full h-[10px] overflow-hidden rounded-[2px] border border-line bg-surface ${className}`}
      style={{
        backgroundImage:
          "radial-gradient(circle, var(--ink-faint) 1px, transparent 1.35px)",
        backgroundSize: "4px 4px",
      }}
      data-workflow-rail={percent}
      aria-hidden
    >
      <span
        className="block h-full transition-[width] duration-200 motion-reduce:transition-none"
        style={{
          width: `${Math.max(0, Math.min(100, percent))}%`,
          backgroundColor: RAIL_ACCENT[status],
          backgroundImage:
            "linear-gradient(90deg, transparent 0 10px, var(--surface) 10px 11px)",
          backgroundSize: "11px 100%",
        }}
      />
    </span>
  );
}

// ── 表头 ──────────────────────────────────────────────────────────────────

/**
 * 那条 Workflow 工具行的行头内容，和普通行同一副骨架：
 *
 *   图标 · 名称 · 一句摘要（跑着时是当前 agent）｜ 进度（轨 + done/total）· 弱色统计 · 状态
 *
 * 只有两段要读：名称 + 进度。token / 用时走行尾弱色统计（和普通行同一处），
 * CLI 自报的调用次数只在悬停里；阶段、脚本、结果展开再看。「Workflow」这个
 * 词不再写出来 —— 图标已经说了，悬停名称可见。
 */
export function WorkflowHead({
  node,
  live,
  elapsed,
}: {
  node: ToolNode;
  live: boolean;
  elapsed: number | null;
}) {
  const vm = buildWorkflowVM(node, live);
  const name = node.meta.workflowName ?? "Workflow";
  const current = node.running && live ? currentStep(vm.phases) : null;
  return (
    <>
      <span className="grid size-4 shrink-0 place-items-center text-ink-faint">
        <ToolIcon name="workflow" />
      </span>
      <span
        className="shrink-0 min-w-11 max-w-60 truncate text-[12.5px] font-medium text-ink"
        title={`Workflow · ${name}`}
      >
        {name}
      </span>
      <span className="flex-1 min-w-0 truncate font-mono text-label text-ink-muted">
        {current ?? ""}
      </span>
      {vm.hasDetail ? (
        <span
          className="shrink-0 inline-flex items-center gap-1.5 font-mono text-nano tabular-nums text-ink-muted"
          title={`${vm.done}/${vm.total} 个 agent 已完成`}
          data-workflow-meta
        >
          <ProgressRail
            percent={vm.percent}
            status={vm.status}
            className="narrow:hidden"
          />
          {vm.done}/{vm.total}
          {vm.failed > 0 && (
            <span className="text-danger-ink">· {vm.failed} 失败</span>
          )}
        </span>
      ) : (
        <span className="shrink-0 text-nano text-ink-faint">暂无阶段明细</span>
      )}
      <RowTail
        node={node}
        stat={statLine(node, elapsed)}
        nestedErrors={0}
        status={rowStatus(node, live)}
      />
    </>
  );
}

// "Review: review:security" —— 最近开始、还没跑完的那个 agent。
export function currentStep(phases: WorkflowPhaseVM[]): string | null {
  let best: { at: number; text: string } | null = null;
  for (const p of phases) {
    for (const a of p.agents) {
      if (a.state !== "running") continue;
      const at = a.entry.startedAt ?? a.entry.queuedAt ?? a.entry.index;
      if (!best || at >= best.at) {
        best = { at, text: p.title ? `${p.title}: ${a.entry.label}` : a.entry.label };
      }
    }
  }
  return best?.text ?? null;
}
