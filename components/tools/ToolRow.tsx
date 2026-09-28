"use client";
import { useState } from "react";
import { useElapsed } from "@/hooks/useElapsed";
import { formatDuration } from "@/lib/format-duration";
import { formatTokens } from "@/lib/format-tokens";
import {
  defaultOpen,
  toolIcon,
  toolSummary,
  toolTitle,
  type ToolIconKey,
} from "@/lib/tool-registry";
import {
  nestedErrorCount,
  segmentTimeline,
  subagentLabel,
  type TimelineEntry,
  type ToolNode,
} from "@/lib/tool-tree";
import { hasValidWorkflowProgress, workflowStatusOf } from "@/lib/workflow-view";
import { Check, ChevronRight } from "lucide-react";
import { Icon, Pill, Spinner, StatusDot, ToolIcon } from "@/components/ui";
import { RawView } from "./RawView";
import { resolveToolView } from "./views";
import { WorkflowHead } from "./views/WorkflowChrome";

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
    <div data-tool-segment="">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={open ? "点击收起明细" : "点击展开已自动收起的明细"}
        className="w-full min-h-7.5 px-3 flex items-center gap-2 text-ui text-left text-ink-faint hover:bg-surface-hover hover:text-ink-muted transition-colors pointer-coarse:min-h-11"
      >
        <Icon
          icon={ChevronRight}
          size="sm"
          className={`transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
        <span className="tabular-nums shrink-0 text-ink-muted">
          {nodes.length} 步
        </span>
        <span className="truncate min-w-0">{segmentSummary(nodes)}</span>
        <span className="shrink-0 text-nano text-ink-faint">
          {open ? "已展开" : "已自动收起"}
        </span>
        <span className="flex-1" />
        <span className="font-mono text-nano tabular-nums shrink-0">
          {segmentDuration(nodes)}
        </span>
      </button>
      {open && (
        <div className="border-t border-line-faint divide-y divide-line-faint">
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

  // 表头自己也读快照（WorkflowHead → buildWorkflowVM），所以只给 body 装
  // canRender 守卫是不够的 —— 畸形快照会从表头这一侧把整行炸掉。同一个守卫，
  // 不合规就退回普通行头：名称、图标、状态胶囊都还在，只是不画进度轨。
  const workflow = node.kind === "workflow" && hasValidWorkflowProgress(node);

  const failed = node.call.status === "error" || node.meta.status === "failed";

  return (
    <div
      data-tool-row={node.kind}
      data-tool-failed={failed ? "" : undefined}
      data-workflow-card={
        workflow ? workflowStatusOf(node, live) : undefined
      }
    >
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        aria-expanded={open}
        data-workflow-head={workflow ? "" : undefined}
        className={`w-full min-h-7.5 px-3 flex items-center gap-2 text-ui text-left hover:bg-surface-hover transition-colors ${
          workflow
            ? "flex-wrap py-1 pointer-coarse:min-h-11"
            : ""
        }`}
      >
        {workflow ? (
          <WorkflowHead node={node} live={live} elapsed={elapsed} />
        ) : (
          <>
            <ToolIcon name={rowIcon(node)} className="text-ink-faint" />
            <span className="shrink-0 max-w-40 truncate font-medium text-ink">
              {rowTitle(node)}
            </span>
            <span className="flex-1 min-w-0 truncate font-mono text-label text-ink-muted">
              {rowSummary(node) ?? ""}
            </span>
            {nestedErrors > 0 && (
              // 收着的委派行也得把肚子里的失败招出来 —— 折叠不是藏错的理由。
              <span className="shrink-0 inline-flex items-center gap-1 text-nano text-danger-ink">
                <StatusDot tone="danger" />
                {nestedErrors} 失败
              </span>
            )}
            <span className="shrink-0 font-mono text-nano tabular-nums text-ink-faint">
              {statLine(node, elapsed)}
            </span>
            <StatusPill node={node} live={live} />
          </>
        )}
      </button>

      {open && (
        <div
          className={`pr-3 pb-3 pt-1 space-y-2 ${
            failed ? "ml-4 pl-4 border-l-2 border-danger-line" : "pl-8"
          }`}
        >
          <Body node={node} live={live}>
            <TimelineList nodes={node.children} live={live} depth={depth + 1} />
          </Body>
          {/* A custom view owns its own body, but children still have to land
              somewhere — only SubagentView slots them in, so any other kind
              that somehow spawned children renders them here. */}
          {!useCustom && node.children.length > 0 && (
            <div className="border-l-2 border-line ml-1 pl-2">
              <div className="border border-line rounded divide-y divide-line-faint overflow-hidden">
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
  // 工具本身报错，或者委派的任务回报 failed（task_updated）—— 两种都是失败，
  // 只认前一种的话，一个跑挂的 Workflow 会安静地收成一行「已失败」。
  if (node.call.status === "error" || node.meta.status === "failed") return true;
  if (live && node.running && node.kind !== "tool") return true;
  if (currentTodo) return true;
  if (live) return false;
  return defaultOpen(node);
}

function rowIcon(node: ToolNode): ToolIconKey {
  if (node.kind === "subagent") return "bot";
  if (node.kind === "workflow") return "workflow";
  if (node.kind === "longRunning") return "timer";
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

/**
 * 行尾状态位 —— 安静是默认值。
 *
 * 跑完的普通行只挂一枚淡灰对勾（一屏 40 行绿胶囊等于没有胶囊）；运行中是
 * Spinner；失败是红点 + 「失败」二字（醒目，但不喊）；turn 已结束却仍开着
 * 的调用承认「已中断」。
 */
export function StatusPill({ node, live }: { node: ToolNode; live: boolean }) {
  if (node.running) {
    return live ? (
      <Spinner size="sm" label="运行中" />
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
      <span className="shrink-0 inline-flex items-center gap-1 text-nano font-medium text-danger-ink">
        <StatusDot tone="danger" />
        失败
      </span>
    );
  }
  return <Icon icon={Check} size="sm" className="text-ink-faint" />;
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

// 秒表搬去了 hooks/useElapsed（Workflow 表头与面板都要用，留在这里会成环）。
// 这里保留出口，调用点不必改。
export { useElapsed };
