"use client";
import { useState } from "react";
import { formatDuration } from "@/lib/format-duration";
import { formatTokens } from "@/lib/format-tokens";
import type { ToolNode } from "@/lib/tool-tree";
import type { WorkflowAgentEntry, WorkflowPhaseEntry } from "@/lib/types";
import { OutputView, Section } from "../RawView";
import { Pill } from "../../ui/Pill";

// The Workflow tool's phase tree.
//
// This used to render as nothing at all: Workflow wasn't in any registry, its
// input is a multi-KB script (so the JSON fallback produced a garbage summary
// line), and because it emits task_* notifications it got swept into the "sub
// agent" box with an empty tool chain and a fake report.
//
// It needs no disk access. The CLI puts the entire progress tree on the wire —
// `workflow_progress` on task_progress, a *full snapshot* roughly once a
// second — so all this component does is group agents under their phase.

function phasesOf(node: ToolNode): WorkflowPhaseEntry[] {
  return (node.meta.workflowProgress ?? []).filter(
    (e): e is WorkflowPhaseEntry => e.type === "workflow_phase",
  );
}

function agentsOf(node: ToolNode): WorkflowAgentEntry[] {
  return (node.meta.workflowProgress ?? []).filter(
    (e): e is WorkflowAgentEntry => e.type === "workflow_agent",
  );
}

export function canRenderWorkflow(node: ToolNode): boolean {
  // A resumed / instantly-failed run can finish before any snapshot arrives.
  // With no phases and no agents there is nothing this view can say that the
  // raw body doesn't say better.
  return phasesOf(node).length > 0 || agentsOf(node).length > 0;
}

export function WorkflowView({ node }: { node: ToolNode }) {
  const phases = phasesOf(node);
  const agents = agentsOf(node);
  const script = node.meta.prompt ?? null;

  // Agents whose phaseIndex matches nothing (or is absent) still have to show
  // up — a workflow that never called phase() puts everything here.
  const known = new Set(phases.map((p) => p.index));
  const loose = agents.filter(
    (a) => a.phaseIndex === undefined || !known.has(a.phaseIndex),
  );

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-nano tabular-nums text-ink-faint">
        {node.meta.workflowName && (
          <span className="font-mono text-ink-muted">{node.meta.workflowName}</span>
        )}
        <span>{phases.length} 阶段</span>
        <span>{agents.length} agent</span>
        <span>{agents.filter((a) => a.state === "done").length} 完成</span>
        {agents.some((a) => a.state !== "done") && (
          <span className="text-warn-ink">
            {agents.filter((a) => a.state !== "done").length} 运行中
          </span>
        )}
        {sumTokens(agents) > 0 && <span>{formatTokens(sumTokens(agents))}</span>}
      </div>

      <div className="space-y-2">
        {phases.map((p) => (
          <PhaseBlock
            key={p.index}
            title={p.title}
            agents={agents.filter((a) => a.phaseIndex === p.index)}
          />
        ))}
        {loose.length > 0 && (
          <PhaseBlock title={phases.length > 0 ? "其他" : "agent"} agents={loose} />
        )}
      </div>

      {script && (
        <details>
          <summary className="cursor-pointer select-none text-nano uppercase tracking-wider text-ink-faint hover:text-ink-muted">
            ⚙ 工作流脚本
          </summary>
          <pre className="mt-1 text-label font-mono whitespace-pre-wrap break-words bg-surface-canvas border border-line rounded px-2 py-1.5 max-h-72 overflow-auto">
            {script}
          </pre>
        </details>
      )}

      {node.call.output && (
        <Section label="返回">
          <OutputView text={node.call.output} />
        </Section>
      )}
    </>
  );
}

// 一个 phase：活跃的（还有 agent 没跑完）自动铺开 agent 行 —— 那是热区；
// 跑完的收成一行 ✔ 标题 + 计数，点击才重新铺开。和 ToolRow 同一套
// 「自动规则 + 用户点击置顶」心智：用户手动开过的完成 phase 不会被
// 下一帧快照收回去。
function PhaseBlock({
  title,
  agents,
}: {
  title: string;
  agents: WorkflowAgentEntry[];
}) {
  const done = agents.filter((a) => a.state === "done").length;
  const running = agents.some((a) => a.state !== "done");
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? running;
  const toggleable = agents.length > 0;
  return (
    <div className="border-l-2 border-line ml-1 pl-2">
      <button
        type="button"
        onClick={toggleable ? () => setUserOpen(!open) : undefined}
        aria-expanded={toggleable ? open : undefined}
        disabled={!toggleable}
        className={`w-full flex items-center gap-2 text-label text-left rounded px-1 -mx-1 ${
          toggleable ? "hover:bg-surface-muted/60 cursor-pointer" : ""
        }`}
      >
        <span className="shrink-0 select-none text-ink-faint">
          {agents.length > 0 && done === agents.length ? "✔" : running ? "▸" : "○"}
        </span>
        <span className="font-medium text-ink">{title}</span>
        {agents.length > 0 && (
          <span className="text-nano tabular-nums text-ink-faint">
            {done}/{agents.length}
          </span>
        )}
      </button>
      {toggleable && open && (
        <div className="mt-1 space-y-0.5">
          {agents.map((a) => (
            <AgentRow key={`${a.index}-${a.agentId ?? a.label}`} agent={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentRow({ agent }: { agent: WorkflowAgentEntry }) {
  const done = agent.state === "done";
  return (
    <details className="group">
      <summary className="cursor-pointer select-none flex items-center gap-2 text-label hover:bg-surface-muted/60 rounded px-1 -mx-1">
        <Pill tone={done ? "positive" : "warn"} className="shrink-0">
          {done ? "完成" : "运行中"}
        </Pill>
        <span className="font-mono text-ink truncate min-w-0">{agent.label}</span>
        <span className="flex-1" />
        <span className="shrink-0 text-nano tabular-nums text-ink-faint">
          {[
            agent.toolCalls ? `${agent.toolCalls} 工具` : null,
            agent.tokens ? formatTokens(agent.tokens) : null,
            agent.durationMs ? formatDuration(agent.durationMs) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </summary>
      <div className="mt-1 mb-1.5 ml-2 space-y-1">
        {agent.model && (
          <div className="text-nano font-mono text-ink-faint">{agent.model}</div>
        )}
        {agent.promptPreview && (
          <Preview label="交给它的任务" text={agent.promptPreview} />
        )}
        {agent.resultPreview && (
          <Preview label="它交回的结果" text={agent.resultPreview} />
        )}
      </div>
    </details>
  );
}

function Preview({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="text-nano uppercase tracking-wider text-ink-faint">
        {label}
      </div>
      <pre className="text-label font-mono whitespace-pre-wrap break-words bg-surface-canvas border border-line rounded px-2 py-1 max-h-40 overflow-auto">
        {text}
      </pre>
    </div>
  );
}

function sumTokens(agents: WorkflowAgentEntry[]): number {
  return agents.reduce((n, a) => n + (a.tokens ?? 0), 0);
}
