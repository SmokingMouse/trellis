"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import { formatTokens } from "@/lib/format-tokens";
import { toolSummary, toolTitle } from "@/lib/tool-registry";
import {
  buildToolTree,
  countToolTree,
  runningChain,
  subagentLabel,
  type ToolNode,
} from "@/lib/tool-tree";
import type { ToolCall, ToolCallStats, WorkflowAgentEntry } from "@/lib/types";
import { useSessionStore } from "@/stores/sessionStore";
import { TimelineList, useElapsed } from "./ToolRow";

// The turn's whole tool timeline, in chronological order.
//
// 结构三层，对应注意力的冷热（见 ToolRow.tsx 的 TimelineList）：
//   热  header 面包屑 —— 此刻正在跑的最深链路（⚙ wf › 🤖 agent › 工具），
//       面板收着也一直可见；失败行、运行中的行。
//   温  骨架 —— 委派实体（子 Agent / Workflow / 长跑命令）+ 计划检查点，
//       一行一个，带聚合统计；这是展开面板后看到的"关系图"。
//   冷  连续已完成的普通工具压成段落 chip，点击才逐行铺开；行的 body 再
//       点击才展开。追溯 = 沿着 摘要行 → 骨架 → 段落 → 行 一层层下钻。
//
// 大会话的 toolCalls 不随会话载荷下发（占比能到 98%，改发预计算 stats），
// 所以 done 节点首次展开时按需拉取（loadNodeToolCalls）；拉取期间折叠态
// 用 stats 渲染角标数字。流式节点不受影响——toolCalls 随流事件进 store。

export function ToolTimeline({
  nodeId,
  toolCalls,
  stats,
  live,
}: {
  nodeId: string;
  toolCalls: ToolCall[];
  stats?: ToolCallStats | null;
  live: boolean;
}) {
  const tree = useMemo(() => buildToolTree(toolCalls), [toolCalls]);
  const counts = useMemo(() => countToolTree(tree), [tree]);
  // null = follow the run: open while it streams (watching it work is the
  // point), collapsed once it's done (the answer is). A click pins it.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? live;

  // 折叠态在 toolCalls 未加载时用 stats 顶上（tree 为空但 stats 有数字）。
  const display = tree.length > 0 ? counts : stats ?? null;
  // toolCalls 被剥离、且这轮确实有工具调用 → 展开时按需拉取。
  const needsLoad = toolCalls.length === 0 && (stats?.total ?? 0) > 0;
  const loadNodeToolCalls = useSessionStore((s) => s.loadNodeToolCalls);
  const loading = useSessionStore((s) => Boolean(s.toolCallsLoading[nodeId]));
  useEffect(() => {
    if (open && needsLoad) void loadNodeToolCalls(nodeId);
  }, [open, needsLoad, nodeId, loadNodeToolCalls]);

  if (!display || display.total === 0) return null;
  const chain = live ? runningChain(tree) : [];

  return (
    <div className="mb-3 border border-line rounded-card overflow-hidden bg-surface-muted/60">
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        aria-expanded={open}
        className="w-full px-3 py-2 flex items-center gap-2 text-ui text-left hover:bg-surface-muted transition-colors"
      >
        <span
          className="text-ink-faint transition-transform shrink-0"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0)" }}
          aria-hidden
        >
          ▸
        </span>
        {chain.length > 0 ? (
          <LiveHeader
            chain={chain}
            parallel={counts.running - chain.length}
          />
        ) : (
          <>
            <span className="font-medium text-ink shrink-0">🧰 动线</span>
            <span className="text-ink-muted tabular-nums shrink-0">
              {display.total} 步
            </span>
            <span className="text-ink-faint truncate min-w-0">
              {summaryLine(tree, display.subagents, display.workflows, stats?.tools)}
            </span>
            {display.errors > 0 && (
              <span className="text-danger-ink shrink-0">
                · {display.errors} 失败
              </span>
            )}
          </>
        )}
        <span className="flex-1" />
        <span className="text-nano text-ink-faint hidden sm:inline shrink-0">
          {open ? "收起" : "展开"}
        </span>
      </button>

      {open &&
        (tree.length > 0 ? (
          <div className="border-t border-line divide-y divide-line/70">
            <TimelineList nodes={tree} live={live} />
          </div>
        ) : (
          // toolCalls 还在按需拉取（或拉取失败静默降级）——给一行占位，
          // 别让展开的面板空着。
          <div className="border-t border-line px-3 py-2 text-ui text-ink-faint flex items-center gap-2">
            {loading ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                正在加载工具调用…
              </>
            ) : (
              <span>工具调用暂无数据</span>
            )}
          </div>
        ))}
    </div>
  );
}

// The live line — a breadcrumb of the deepest running chain, root → leaf.
// Always in the header, open or collapsed: this is the one thing the user
// wants while it streams, and it's also the "who spawned whom" answer without
// opening anything. The leaf reaches one step deeper than tool_call events
// can see — a sub-agent's current tool / a workflow's running agent — via
// live task metadata.
function LiveHeader({
  chain,
  parallel,
}: {
  chain: ToolNode[];
  parallel: number;
}) {
  const leaf = chain[chain.length - 1];
  const elapsed = useElapsed(leaf.call.startedAt);
  const crumbs = chain.map(crumbLabel);
  const step = leafStep(leaf);
  if (step) crumbs.push(step);
  const doing = leafDoing(leaf);
  const stat = [
    leaf.meta.totalTokens ? formatTokens(leaf.meta.totalTokens) : null,
    elapsed !== null ? `${Math.round(elapsed / 1000)}s` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <span className="font-medium text-ink shrink-0" aria-hidden>
        🧰
      </span>
      <span className="flex items-center gap-1 min-w-0 font-medium text-ink">
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <span className="text-ink-faint shrink-0" aria-hidden>
                ›
              </span>
            )}
            {/* 挤不下时先牺牲上游环节 —— 叶子（正在跑的那个）永远完整。 */}
            <span
              className={
                i === crumbs.length - 1 ? "shrink-0" : "truncate min-w-0"
              }
            >
              {c}
            </span>
          </Fragment>
        ))}
      </span>
      {doing && (
        <span className="text-warn-ink truncate min-w-0">{doing}</span>
      )}
      {stat && (
        <span className="text-ink-faint tabular-nums shrink-0 hidden sm:inline">
          {stat}
        </span>
      )}
      {parallel > 0 && (
        <span className="text-ink-faint shrink-0">+{parallel} 并行</span>
      )}
      <span
        className="w-1.5 h-1.5 rounded-full bg-warn animate-pulse shrink-0"
        aria-hidden
      />
    </>
  );
}

function crumbLabel(n: ToolNode): string {
  if (n.kind === "subagent") return `🤖 ${subagentLabel(n.meta)}`;
  if (n.kind === "workflow") return `⚙ ${n.meta.workflowName ?? "Workflow"}`;
  if (n.kind === "longRunning") return `⏱ ${toolTitle(n.call)}`;
  return toolTitle(n.call);
}

// 面包屑的最后一格：委派叶子此刻抓着的东西。tool_call 事件到不了这一层
// （子 Agent 的内部调用有事件，但 workflow 的 agent 没有），task 元数据有。
function leafStep(leaf: ToolNode): string | null {
  if (leaf.kind === "subagent") return leaf.meta.lastToolName ?? null;
  if (leaf.kind === "workflow") {
    const agents = (leaf.meta.workflowProgress ?? []).filter(
      (e): e is WorkflowAgentEntry => e.type === "workflow_agent",
    );
    const running = agents.filter((a) => a.state !== "done");
    return running.length > 0 ? running[running.length - 1].label : null;
  }
  return null;
}

function leafDoing(leaf: ToolNode): string | null {
  if (leaf.kind === "subagent" || leaf.kind === "workflow") {
    // description is live-updated by task_progress to the current step.
    return leaf.meta.description ?? null;
  }
  return toolSummary(leaf.call);
}

function summaryLine(
  tree: ToolNode[],
  subagents: number,
  workflows: number,
  // toolCalls 被剥离时（大会话 done 节点）tree 为空，用服务端预计算的
  // 顶层工具名顶上，保住 "Bash、Read、Edit" 这行点名。
  statsTools?: string[],
): string {
  const parts: string[] = [];
  if (subagents > 0) parts.push(`${subagents} 子 Agent`);
  if (workflows > 0) parts.push(`${workflows} Workflow`);
  if (parts.length === 0) {
    // No delegation — name the tools instead, so the collapsed line still
    // says something ("Bash、Read、Edit").
    const names =
      tree.length > 0
        ? [...new Set(tree.map((n) => toolTitle(n.call)))]
        : (statsTools ?? []);
    if (names.length === 0) return "";
    return names.slice(0, 4).join("、") + (names.length > 4 ? "…" : "");
  }
  return `· ${parts.join(" · ")}`;
}
