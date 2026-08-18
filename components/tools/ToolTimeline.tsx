"use client";
import { useEffect, useMemo, useState } from "react";
import { formatTokens } from "@/lib/format-tokens";
import { toolTitle } from "@/lib/tool-registry";
import {
  buildToolTree,
  countToolTree,
  subagentLabel,
  walkToolTree,
  type ToolNode,
} from "@/lib/tool-tree";
import type { ToolCall, ToolCallStats } from "@/lib/types";
import { useSessionStore } from "@/stores/sessionStore";
import { ToolRow, useElapsed } from "./ToolRow";

// The turn's whole tool timeline, in chronological order, one row per call.
//
// Replaces the old pair of panels (🔧 工具调用 for the main agent + a separate
// 🤖 子 Agent box). Splitting them meant delegated work had to be *removed*
// from the main list to appear in its own box, so the two panels each told
// half the story and neither preserved the order things actually happened in.
// One tree, nested where nesting is real, is both simpler and more honest.
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
  const running = live ? walkToolTree(tree).filter((n) => n.running) : [];

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
        {running.length > 0 ? (
          <LiveHeader running={running} />
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
            {tree.map((n) => (
              <ToolRow key={n.call.id} node={n} live={live} />
            ))}
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

// The folded-state live line — the reason a collapsed panel is acceptable at
// all. Without it a folded timeline meant the user had no idea anything was
// happening. Deepest running node wins: while a sub-agent runs, what you want
// to see is the tool *it* is running, not the word "Agent".
function LiveHeader({ running }: { running: ToolNode[] }) {
  const node = running[running.length - 1];
  const elapsed = useElapsed(node.call.startedAt);
  const label =
    node.kind === "subagent"
      ? subagentLabel(node.meta)
      : node.kind === "workflow"
        ? (node.meta.workflowName ?? "Workflow")
        : toolTitle(node.call);
  const doing = node.meta.lastToolName ?? node.meta.description;
  return (
    <>
      <span className="font-medium text-ink shrink-0">🧰 {label}</span>
      {doing && (
        <span className="text-warn-ink truncate min-w-0">正在 {doing}</span>
      )}
      <span className="text-ink-faint tabular-nums shrink-0 hidden sm:inline">
        {[
          node.meta.totalTokens ? formatTokens(node.meta.totalTokens) : null,
          elapsed !== null ? `${Math.round(elapsed / 1000)}s` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
      {running.length > 1 && (
        <span className="text-ink-faint shrink-0">+{running.length - 1}</span>
      )}
      <span
        className="w-1.5 h-1.5 rounded-full bg-warn animate-pulse shrink-0"
        aria-hidden
      />
    </>
  );
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
