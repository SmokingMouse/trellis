"use client";
import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/format-duration";
import { formatTokens } from "@/lib/format-tokens";
import { defaultOpen, toolIcon, toolSummary, toolTitle } from "@/lib/tool-registry";
import { subagentLabel, type ToolNode } from "@/lib/tool-tree";
import { Pill } from "../ui/Pill";
import { RawView } from "./RawView";
import { resolveToolView } from "./views";

// One row of the timeline. Recursive: a sub-agent's own calls render as the
// same component one level in, so nesting depth costs nothing to support.

export function ToolRow({
  node,
  live,
  depth = 0,
}: {
  node: ToolNode;
  live: boolean;
  depth?: number;
}) {
  // null = "follow the automatic rule"; once the user clicks, their choice
  // sticks even when the automatic rule would flip (e.g. the sub-agent they
  // just collapsed starts another tool).
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? rowAutoOpen(node, live);

  const view = resolveToolView(node);
  const useCustom = view?.canRender(node) ?? false;
  const Body = useCustom ? view!.Component : RawView;

  const elapsed = useElapsed(live && node.running ? node.call.startedAt : null);

  return (
    <div className="bg-surface/60">
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        aria-expanded={open}
        className="w-full px-3 py-2 flex items-center gap-2 text-ui text-left hover:bg-surface-muted/60 transition-colors"
      >
        <span
          className="text-ink-faint transition-transform shrink-0"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0)" }}
          aria-hidden
        >
          ▸
        </span>
        <StatusPill node={node} live={live} />
        <span className="shrink-0 select-none text-ink-faint" aria-hidden>
          {rowIcon(node)}
        </span>
        <span className="font-mono text-ink shrink-0">{rowTitle(node)}</span>
        <span className="text-ink-muted truncate min-w-0">
          {rowSummary(node) ?? ""}
        </span>
        <span className="flex-1" />
        <span className="text-nano tabular-nums text-ink-faint shrink-0">
          {statLine(node, elapsed)}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2">
          <Body node={node}>
            {node.children.map((c) => (
              <ToolRow key={c.call.id} node={c} live={live} depth={depth + 1} />
            ))}
          </Body>
          {/* A custom view owns its own body, but children still have to land
              somewhere — only SubagentView slots them in, so any other kind
              that somehow spawned children renders them here. */}
          {!useCustom && node.children.length > 0 && (
            <div className="border-l-2 border-line ml-1 pl-2">
              <div className="border border-line rounded divide-y divide-line/70 overflow-hidden">
                {node.children.map((c) => (
                  <ToolRow key={c.call.id} node={c} live={live} depth={depth + 1} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Whether a row starts expanded, absent a user click.
 *
 * Three reasons to open on arrival, in the order they were learned:
 *   - the registry says the body *is* the content (a diff, a checklist)
 *   - it's running right now and it's a delegation — watching it work is the
 *     whole point of a live timeline (happy's dynamic Task.minimal, same idea)
 *   - it failed. Anything else buries the one row that explains why the turn
 *     went sideways behind a click, which makes "errors are never hidden" a
 *     slogan rather than a behaviour.
 */
export function rowAutoOpen(node: ToolNode, live: boolean): boolean {
  if (node.call.status === "error") return true;
  if (live && node.running && node.kind !== "tool") return true;
  return defaultOpen(node);
}

function rowIcon(node: ToolNode): string {
  if (node.kind === "subagent") return "🤖";
  if (node.kind === "workflow") return "⚙";
  if (node.kind === "longRunning") return "⏱";
  return toolIcon(node.call);
}

function rowTitle(node: ToolNode): string {
  if (node.kind === "subagent") return subagentLabel(node.meta);
  if (node.kind === "workflow") return node.meta.workflowName ?? "Workflow";
  return toolTitle(node.call);
}

function rowSummary(node: ToolNode): string | null {
  // Delegations label themselves through task metadata, which is live-updated
  // and richer than anything sniffable out of the tool input.
  if (node.kind === "subagent" || node.kind === "workflow") {
    return node.meta.description ?? toolSummary(node.call);
  }
  return toolSummary(node.call);
}

export function StatusPill({ node, live }: { node: ToolNode; live: boolean }) {
  if (node.running) {
    return live ? (
      <Pill tone="warn" className="shrink-0">
        运行中
      </Pill>
    ) : (
      // The turn ended while this call was still open — aborted, or the run
      // died. Showing "运行中" forever is worse than admitting we lost it.
      <Pill tone="neutral" className="shrink-0">
        已中断
      </Pill>
    );
  }
  if (node.call.status === "error" || node.meta.status === "failed") {
    return (
      <Pill tone="danger" className="shrink-0">
        失败
      </Pill>
    );
  }
  return (
    <Pill tone="positive" className="shrink-0">
      完成
    </Pill>
  );
}

// "3 工具 · 12.4k · 8s". Counts come from the CLI's own task_progress usage
// when present (it counts what the sub-agent actually did, including calls
// that never surfaced as tool_use blocks); otherwise from the rows we have.
function statLine(node: ToolNode, elapsed: number | null): string {
  const parts: string[] = [];
  if (node.kind !== "tool") {
    const tools = node.meta.toolUses ?? node.children.length;
    if (tools > 0) parts.push(`${tools} 工具`);
    if (node.meta.totalTokens) parts.push(formatTokens(node.meta.totalTokens));
  }
  const ms = elapsed ?? node.call.durationMs ?? node.meta.durationMs ?? null;
  if (ms !== null) parts.push(formatDuration(ms));
  return parts.join(" · ");
}

// Ticking elapsed time for a running call. task_progress only lands between
// tool calls, so leaning on its duration_ms leaves the counter frozen through
// a long Bash — the one moment the user most wants to see it moving.
// Returns null when not running (callers fall back to the recorded duration).
export function useElapsed(startedAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  if (startedAt === null) return null;
  return Math.max(0, now - startedAt);
}
