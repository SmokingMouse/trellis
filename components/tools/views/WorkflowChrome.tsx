"use client";
import { formatDuration } from "@/lib/format-duration";
import { formatTokens } from "@/lib/format-tokens";
import type { ToolNode } from "@/lib/tool-tree";
import {
  AGENT_STATE_LABEL,
  buildWorkflowVM,
  WORKFLOW_STATUS_LABEL,
  type AgentState,
  type WorkflowStatus,
} from "@/lib/workflow-view";
import { Pill } from "../../ui/Pill";

// Workflow 卡的「外壳」：表头那一行、状态胶囊、进度轨、状态字形。
//
// 单独成文件是为了打断环：表头由 ToolRow 渲染（Workflow 就是动线里那条工具
// 行，不另起卡片），面板由 views/WorkflowView 渲染，两边都要用这里的零件。

// ── 字形 ──────────────────────────────────────────────────────────────────

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className={`animate-spin motion-reduce:animate-none ${className}`}
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" strokeOpacity="0.24" />
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

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
        <Spinner className="w-3 h-3" />
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

// ── 状态胶囊 ──────────────────────────────────────────────────────────────

const CHIP_TONE = {
  running: "neutral",
  completed: "positive",
  failed: "danger",
  killed: "neutral",
} as const;

export function WorkflowChip({ status }: { status: WorkflowStatus }) {
  return (
    <Pill tone={CHIP_TONE[status]} className="shrink-0">
      {status === "running" && <Spinner className="w-2.5 h-2.5" />}
      {WORKFLOW_STATUS_LABEL[status]}
    </Pill>
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
}: {
  percent: number;
  status: WorkflowStatus;
}) {
  return (
    <span
      className="relative block shrink-0 w-[72px] max-w-full h-[10px] overflow-hidden rounded-[2px] border border-line bg-surface"
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
 * 那条 Workflow 工具行的行头内容（折叠箭头之后的部分）。
 *
 * 收起时它**就是**摘要，所以名称 / 状态 / 进度 / n-m agents / 用时 / token /
 * 次调用 全在这一行；窄屏（≤560px）数字整体换到第二行，靠 flex-wrap，不另做
 * 一套结构。
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
  const ms = elapsed ?? node.call.durationMs ?? node.meta.durationMs ?? null;
  return (
    <>
      <span className="shrink-0 select-none text-ink-faint" aria-hidden>
        ⚙
      </span>
      <span className="min-w-0 truncate text-ink-muted font-medium">
        <span className="font-normal text-ink-faint">Workflow</span>{" "}
        {node.meta.workflowName ?? "Workflow"}
      </span>
      <WorkflowChip status={vm.status} />
      {/* 这一行全是要**读**的数值（进度、用时、token、次调用），浅色下
          ink-faint（stone-400 on #fff）配 nano 字号偏淡 —— 数值提一档到
          ink-muted，单位词留在 faint 当注脚。深色不回退：ink-muted 在暗色是
          stone-400，比 ink-faint 的 stone-500 更亮，对比只增不减。 */}
      <span
        className="flex flex-wrap items-center gap-x-2 gap-y-0.5 ml-auto font-mono text-nano leading-4 tabular-nums text-ink-muted narrow:ml-0 narrow:w-full narrow:pl-5 narrow:justify-start"
        data-workflow-meta
      >
        {vm.hasDetail && (
          <>
            <ProgressRail percent={vm.percent} status={vm.status} />
            <span>
              {vm.done}/{vm.total} agents
              {vm.failed > 0 ? ` · ${vm.failed} 个已失败` : ""}
            </span>
          </>
        )}
        {ms !== null && <span>{formatDuration(ms)}</span>}
        {node.meta.totalTokens ? (
          <span>
            {formatTokens(node.meta.totalTokens)}{" "}
            <i className="not-italic text-ink-faint">tokens</i>
          </span>
        ) : null}
        {node.meta.toolUses ? (
          <span>
            {node.meta.toolUses}{" "}
            <i className="not-italic text-ink-faint">次调用</i>
          </span>
        ) : null}
        {!vm.hasDetail && <span className="text-ink-faint">暂无阶段明细</span>}
      </span>
    </>
  );
}
