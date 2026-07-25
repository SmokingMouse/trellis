"use client";
import { useEffect, useState } from "react";
import { formatTokens } from "@/lib/format-tokens";
import { subagentLabel, type SubagentGroup } from "@/lib/subagents";
import { formatDuration, ToolCallRow } from "./ToolCallsPanel";
import { Pill } from "./ui/Pill";

// Stage 22: the sub-agent section. Sits above 🔧 工具调用 (which keeps the
// main agent's own chain) so delegated work reads as its own thing instead
// of being interleaved into one flat list.
//
// Two jobs, in priority order:
//   1. While running — say so WITHOUT being expanded. The header carries the
//      live line (which agent, what it's doing right now, tools/tokens/elapsed)
//      because a folded panel meant the user had no idea a sub-agent was even
//      working. That was the original complaint.
//   2. Once done — the task it was given, its tool chain, and its report.

// `live` = the node's run is still going. A tool call that never got its
// result stays status="running" forever (abort / crash mid-turn), so call
// status alone would leave a dead run showing a forever-climbing timer —
// worse than no indicator. The node's own status is the ground truth.
export function SubagentPanel({
  groups,
  live,
}: {
  groups: SubagentGroup[];
  live: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (groups.length === 0) return null;

  const running = live ? groups.filter((g) => g.running) : [];
  const head = running[0];

  return (
    <div className="mb-3 border border-line rounded-card overflow-hidden bg-surface-muted/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-2 flex items-center gap-2 text-ui text-left hover:bg-surface-muted transition-colors"
      >
        <span
          className="text-ink-faint transition-transform shrink-0"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0)" }}
          aria-hidden
        >
          ▸
        </span>
        {head ? (
          <LiveHeader group={head} extraRunning={running.length - 1} />
        ) : (
          <>
            <span className="font-medium text-ink">🤖 子 Agent</span>
            <span className="text-ink-muted tabular-nums">{groups.length}</span>
            <span className="text-ink-faint truncate">
              · {groups.map((g) => subagentLabel(g.meta)).join("、")}
            </span>
          </>
        )}
        <span className="flex-1" />
        <span className="text-nano text-ink-faint hidden sm:inline shrink-0">
          {open ? "收起" : "展开"}
        </span>
      </button>

      {open && (
        <div className="border-t border-line divide-y divide-line/70">
          {groups.map((g) => (
            <SubagentCard key={g.call.id} group={g} live={live} />
          ))}
        </div>
      )}
    </div>
  );
}

// The folded-state live line: 🤖 general-purpose 正在 Bash · 3 工具 · 12.4k · 8s ●
function LiveHeader({
  group,
  extraRunning,
}: {
  group: SubagentGroup;
  extraRunning: number;
}) {
  const elapsed = useElapsed(group.call.startedAt);
  const { meta } = group;
  const doing = meta.lastToolName ?? meta.description;
  return (
    <>
      <span className="font-medium text-ink shrink-0">
        🤖 {subagentLabel(meta)}
      </span>
      {doing && (
        <span className="text-warn-ink truncate min-w-0">正在 {doing}</span>
      )}
      <span className="text-ink-faint tabular-nums shrink-0 hidden sm:inline">
        {statLine(group, elapsed)}
      </span>
      {extraRunning > 0 && (
        <span className="text-ink-faint shrink-0">+{extraRunning}</span>
      )}
      <span
        className="w-1.5 h-1.5 rounded-full bg-warn animate-pulse shrink-0"
        aria-hidden
      />
    </>
  );
}

function SubagentCard({
  group,
  live,
}: {
  group: SubagentGroup;
  live: boolean;
}) {
  const running = live && group.running;
  const [open, setOpen] = useState(running);
  const { meta, call } = group;
  const elapsed = useElapsed(running ? call.startedAt : null);

  return (
    <div className="bg-surface/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-2 flex items-center gap-2 text-ui text-left hover:bg-surface-muted/60 transition-colors"
      >
        <span
          className="text-ink-faint transition-transform shrink-0"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0)" }}
          aria-hidden
        >
          ▸
        </span>
        <StatusPill group={group} live={live} />
        <span className="font-mono text-ink shrink-0">
          {subagentLabel(meta)}
        </span>
        <span className="text-ink-muted truncate min-w-0">
          {meta.description ?? ""}
        </span>
        <span className="flex-1" />
        <span className="text-nano tabular-nums text-ink-faint shrink-0">
          {statLine(group, elapsed)}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2">
          {meta.prompt && (
            <details>
              <summary className="cursor-pointer select-none text-nano uppercase tracking-wider text-ink-faint hover:text-ink-muted">
                📋 交给它的任务
              </summary>
              <pre className="mt-1 text-label font-mono whitespace-pre-wrap break-words bg-surface-canvas border border-line rounded px-2 py-1.5 max-h-60 overflow-auto">
                {meta.prompt}
              </pre>
            </details>
          )}

          {group.children.length > 0 ? (
            // Left rail = "these belong to the sub-agent, not the main chain".
            <div className="border-l-2 border-line ml-1 pl-2">
              <div className="text-nano uppercase tracking-wider text-ink-faint mb-0.5">
                它的工具链 · {group.children.length}
              </div>
              <div className="border border-line rounded divide-y divide-line/70 overflow-hidden">
                {group.children.map((c) => (
                  <ToolCallRow key={c.id} call={c} />
                ))}
              </div>
            </div>
          ) : (
            <div className="text-label text-ink-faint italic">
              {group.running ? "还没开始调工具…" : "没有调用工具"}
            </div>
          )}

          {group.report && (
            <div>
              <div className="text-nano uppercase tracking-wider text-ink-faint mb-0.5">
                📄 它交回的报告
              </div>
              <pre className="text-label font-mono whitespace-pre-wrap break-words bg-surface-canvas border border-line rounded px-2 py-1.5 max-h-96 overflow-auto">
                {group.report}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusPill({ group, live }: { group: SubagentGroup; live: boolean }) {
  if (group.running) {
    return live ? (
      <Pill tone="warn" className="shrink-0">
        运行中
      </Pill>
    ) : (
      // Turn ended while this call was still open — aborted or the run died.
      <Pill tone="neutral" className="shrink-0">
        已中断
      </Pill>
    );
  }
  if (group.call.status === "error" || group.meta.status === "failed") {
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
function statLine(group: SubagentGroup, elapsed: number | null): string {
  const parts: string[] = [];
  const tools = group.meta.toolUses ?? group.children.length;
  if (tools > 0) parts.push(`${tools} 工具`);
  if (group.meta.totalTokens) parts.push(formatTokens(group.meta.totalTokens));
  const ms =
    elapsed ??
    group.call.durationMs ??
    group.meta.durationMs ??
    null;
  if (ms !== null) parts.push(formatDuration(ms));
  return parts.join(" · ");
}

// Ticking elapsed time for a running sub-agent. task_progress only lands
// between tool calls, so leaning on its duration_ms leaves the counter frozen
// through a long Bash — the one moment the user most wants to see it moving.
// Returns null when not running (callers fall back to the recorded duration).
function useElapsed(startedAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  if (startedAt === null) return null;
  return Math.max(0, now - startedAt);
}
