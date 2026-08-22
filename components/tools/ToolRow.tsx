"use client";
import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/format-duration";
import { formatTokens } from "@/lib/format-tokens";
import { defaultOpen, toolIcon, toolSummary, toolTitle } from "@/lib/tool-registry";
import {
  nestedErrorCount,
  segmentTimeline,
  subagentLabel,
  type TimelineEntry,
  type ToolNode,
} from "@/lib/tool-tree";
import { Pill } from "../ui/Pill";
import { RawView } from "./RawView";
import { resolveToolView } from "./views";

// The timeline's rendering layer, three pieces in one file (they're mutually
// recursive — a sub-agent's body renders a TimelineList of its own):
//
//   TimelineList  one sibling list → segments + standalone rows (the skeleton)
//   SegmentRow    a run of completed plain calls, folded to one dim chip
//   ToolRow       one standalone call, recursive through delegations
//
// 冷热纪律（本次重排的核心）：屏幕上的常驻位置只留给「热」的东西 —— 正在跑的
// 行、失败、委派骨架、当前计划（最后一个 TodoWrite）。已完成的普通工具连跑
// 压成一枚段落 chip（冷数据点击才展开），live 期间已完成行的 registry
// defaultOpen（diff / 清单）也一律压制 —— 那是「刚才发生过的事」，不该把正在
// 发生的事推出屏幕。

export function TimelineList({
  nodes,
  live,
  depth = 0,
}: {
  nodes: ToolNode[];
  live: boolean;
  depth?: number;
}) {
  const entries = segmentTimeline(nodes);
  // 整个列表就是一枚段落、且不在流式中 —— chip 只会复读上一级已经说过的
  // 计数，纯属白点一下。直接铺行（live 期间不豁免：chip 的高度上限正是流式
  // 期间要的）。
  const itemize =
    !live && entries.length === 1 && entries[0].type === "segment";
  // 最后一个 TodoWrite 是「当前计划」，live 期间也保持展开 —— 它是热数据，
  // 之前的 TodoWrite 都只是它的历史版本。
  const currentTodoId = [...nodes]
    .reverse()
    .find((n) => n.call.name === "TodoWrite")?.call.id;

  const row = (n: ToolNode) => (
    <ToolRow
      key={n.call.id}
      node={n}
      live={live}
      depth={depth}
      currentTodo={n.call.id === currentTodoId}
    />
  );

  if (itemize) return <>{nodes.map(row)}</>;
  return (
    <>
      {entries.map((e) =>
        e.type === "node" ? (
          row(e.node)
        ) : (
          <SegmentRow
            // 段首 call 的 id 在后续调用并入时保持不变 —— 用户展开过的段
            // 不会因为新调用滚入而弹回收起。
            key={`seg-${e.nodes[0].call.id}`}
            entry={e}
            live={live}
            depth={depth}
          />
        ),
      )}
    </>
  );
}

// A run of completed plain calls, folded into one line. Deliberately colder
// than a ToolRow: no status pills, no per-call titles, faint ink — it should
// read as "9 steps happened here", not compete with the skeleton.
function SegmentRow({
  entry,
  live,
  depth,
}: {
  entry: Extract<TimelineEntry, { type: "segment" }>;
  live: boolean;
  depth: number;
}) {
  const [open, setOpen] = useState(false);
  const { nodes } = entry;
  return (
    <div className="bg-surface/60">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full px-3 py-1.5 flex items-center gap-2 text-ui text-left text-ink-faint hover:bg-surface-muted/60 hover:text-ink-muted transition-colors"
      >
        <span
          className="transition-transform shrink-0"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0)" }}
          aria-hidden
        >
          ▸
        </span>
        <span className="shrink-0 select-none" aria-hidden>
          ⋯
        </span>
        <span className="tabular-nums shrink-0">{nodes.length} 步</span>
        <span className="truncate min-w-0">{segmentSummary(nodes)}</span>
        <span className="flex-1" />
        <span className="text-nano tabular-nums shrink-0">
          {segmentDuration(nodes)}
        </span>
      </button>
      {open && (
        <div className="border-t border-line/70 divide-y divide-line/70">
          {nodes.map((n) => (
            <ToolRow key={n.call.id} node={n} live={live} depth={depth} />
          ))}
        </div>
      )}
    </div>
  );
}

// "Read ×5 · Edit ×3 · Bash" — tool names in first-appearance order.
function segmentSummary(nodes: ToolNode[]): string {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const t = toolTitle(n.call);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const names = [...counts.entries()].map(([t, c]) =>
    c > 1 ? `${t} ×${c}` : t,
  );
  return names.slice(0, 4).join(" · ") + (names.length > 4 ? " …" : "");
}

// Only worth a number when the run actually took time — a pile of instant
// reads summing to 80ms is noise.
function segmentDuration(nodes: ToolNode[]): string {
  const ms = nodes.reduce((s, n) => s + (n.call.durationMs ?? 0), 0);
  return ms >= 1000 ? formatDuration(ms) : "";
}

// One standalone row. Recursive: a sub-agent's own calls render as a nested
// TimelineList one level in, so nesting depth costs nothing to support.

export function ToolRow({
  node,
  live,
  depth = 0,
  currentTodo = false,
}: {
  node: ToolNode;
  live: boolean;
  depth?: number;
  currentTodo?: boolean;
}) {
  // null = "follow the automatic rule"; once the user clicks, their choice
  // sticks even when the automatic rule would flip (e.g. the sub-agent they
  // just collapsed starts another tool).
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? rowAutoOpen(node, live, currentTodo);

  const view = resolveToolView(node);
  const useCustom = view?.canRender(node) ?? false;
  const Body = useCustom ? view!.Component : RawView;

  const elapsed = useElapsed(live && node.running ? node.call.startedAt : null);
  const nestedErrors = node.kind === "tool" ? 0 : nestedErrorCount(node);

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
        {nestedErrors > 0 && (
          // 收着的委派行也得把肚子里的失败招出来 —— 折叠不是藏错的理由。
          <span className="text-nano text-danger-ink shrink-0">
            {nestedErrors} 失败
          </span>
        )}
        <span className="text-nano tabular-nums text-ink-faint shrink-0">
          {statLine(node, elapsed)}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2">
          <Body node={node}>
            <TimelineList nodes={node.children} live={live} depth={depth + 1} />
          </Body>
          {/* A custom view owns its own body, but children still have to land
              somewhere — only SubagentView slots them in, so any other kind
              that somehow spawned children renders them here. */}
          {!useCustom && node.children.length > 0 && (
            <div className="border-l-2 border-line ml-1 pl-2">
              <div className="border border-line rounded divide-y divide-line/70 overflow-hidden">
                <TimelineList
                  nodes={node.children}
                  live={live}
                  depth={depth + 1}
                />
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
 * Reasons to open on arrival:
 *   - it failed. Anything else buries the one row that explains why the turn
 *     went sideways behind a click, which makes "errors are never hidden" a
 *     slogan rather than a behaviour.
 *   - it's running right now and it's a delegation — watching it work is the
 *     whole point of a live timeline (its history is folded by TimelineList,
 *     so opening it shows a skeleton, not a wall).
 *   - it's the *current* todo list — the turn's live plan state is hot data.
 *   - the run is over and the registry says the body *is* the content (a
 *     diff, a checklist). While the run is live these stay collapsed: a diff
 *     that already happened is cold, and auto-opening it pushes the row
 *     that's actually running off screen.
 */
export function rowAutoOpen(
  node: ToolNode,
  live: boolean,
  currentTodo = false,
): boolean {
  if (node.call.status === "error") return true;
  if (live && node.running && node.kind !== "tool") return true;
  if (currentTodo) return true;
  if (live) return false;
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
