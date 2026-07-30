"use client";
import { useMemo, useState } from "react";
import { formatTokens } from "@/lib/format-tokens";
import { toolTitle } from "@/lib/tool-registry";
import {
  buildToolTree,
  countToolTree,
  subagentLabel,
  walkToolTree,
  type ToolNode,
} from "@/lib/tool-tree";
import type { ToolCall } from "@/lib/types";
import { ToolRow, useElapsed } from "./ToolRow";

// The turn's whole tool timeline, in chronological order, one row per call.
//
// Replaces the old pair of panels (🔧 工具调用 for the main agent + a separate
// 🤖 子 Agent box). Splitting them meant delegated work had to be *removed*
// from the main list to appear in its own box, so the two panels each told
// half the story and neither preserved the order things actually happened in.
// One tree, nested where nesting is real, is both simpler and more honest.

export function ToolTimeline({
  toolCalls,
  live,
}: {
  toolCalls: ToolCall[];
  live: boolean;
}) {
  const tree = useMemo(() => buildToolTree(toolCalls), [toolCalls]);
  const counts = useMemo(() => countToolTree(tree), [tree]);
  // null = follow the run: open while it streams (watching it work is the
  // point), collapsed once it's done (the answer is). A click pins it.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? live;

  if (tree.length === 0) return null;
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
              {counts.total} 步
            </span>
            <span className="text-ink-faint truncate min-w-0">
              {summaryLine(tree, counts.subagents, counts.workflows)}
            </span>
            {counts.errors > 0 && (
              <span className="text-danger-ink shrink-0">
                · {counts.errors} 失败
              </span>
            )}
          </>
        )}
        <span className="flex-1" />
        <span className="text-nano text-ink-faint hidden sm:inline shrink-0">
          {open ? "收起" : "展开"}
        </span>
      </button>

      {open && (
        <div className="border-t border-line divide-y divide-line/70">
          {tree.map((n) => (
            <ToolRow key={n.call.id} node={n} live={live} />
          ))}
        </div>
      )}
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
): string {
  const parts: string[] = [];
  if (subagents > 0) parts.push(`${subagents} 子 Agent`);
  if (workflows > 0) parts.push(`${workflows} Workflow`);
  if (parts.length === 0) {
    // No delegation — name the tools instead, so the collapsed line still
    // says something ("Bash、Read、Edit").
    const names = [...new Set(tree.map((n) => toolTitle(n.call)))];
    return names.slice(0, 4).join("、") + (names.length > 4 ? "…" : "");
  }
  return `· ${parts.join(" · ")}`;
}
