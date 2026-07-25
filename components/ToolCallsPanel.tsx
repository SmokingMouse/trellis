"use client";
import { useState } from "react";
import { Pill } from "./ui/Pill";
import type { ToolCall } from "@/lib/types";

// Stage 17: collapsed visualization of every tool the model invoked
// during this turn. Sits above the markdown response in NodeFullView.
//
// Closed by default — most users just want the answer. Expanding the
// outer panel reveals one row per call (name + status pill + duration).
// Each row is its own disclosure that shows pretty-printed input and
// truncated output. Long outputs (Bash logs especially) clamp to
// MAX_OUTPUT_LINES and show a "展开 X 行" toggle.
//
// Stage 22: this panel now shows the MAIN agent's calls only. The caller
// (TurnCard) splits the raw list with splitToolChain(); sub-agent work goes
// to SubagentPanel, which reuses ToolCallRow for the nested rows.

const MAX_OUTPUT_LINES = 200;

export function ToolCallsPanel({
  toolCalls,
  hasSubagents = false,
}: {
  toolCalls: ToolCall[];
  hasSubagents?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (toolCalls.length === 0) return null;

  const runningCount = toolCalls.filter((c) => c.status === "running").length;
  const errorCount = toolCalls.filter((c) => c.status === "error").length;

  return (
    <div className="mb-3 border border-line rounded-card overflow-hidden bg-surface-muted/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-2 flex items-center gap-2 text-ui hover:bg-surface-muted transition-colors"
      >
        <span
          className="text-ink-faint transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0)" }}
          aria-hidden
        >
          ▸
        </span>
        <span className="font-medium text-ink">
          🔧 工具调用{hasSubagents && "（主 agent）"}
        </span>
        <span className="text-ink-muted tabular-nums">
          {toolCalls.length}
        </span>
        {runningCount > 0 && (
          <span className="text-warn-ink">
            · {runningCount} 进行中
          </span>
        )}
        {errorCount > 0 && (
          <span className="text-danger-ink">
            · {errorCount} 失败
          </span>
        )}
        <span className="flex-1" />
        <span className="text-nano text-ink-faint hidden sm:inline">
          {open ? "收起" : "展开"}
        </span>
      </button>

      {open && (
        <div className="border-t border-line divide-y divide-line/70">
          {toolCalls.map((tc) => (
            <ToolCallRow key={tc.id} call={tc} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ToolCallRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const summary = oneLineSummary(call);
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
        <StatusPill status={call.status} />
        <span className="font-mono text-ink shrink-0">
          {call.name}
        </span>
        <span className="text-ink-muted truncate">
          {summary}
        </span>
        <span className="flex-1" />
        {call.durationMs !== null && (
          <span className="text-nano tabular-nums text-ink-faint shrink-0">
            {formatDuration(call.durationMs)}
          </span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2">
          <Section label="输入">
            <pre className="text-label font-mono whitespace-pre-wrap break-words bg-surface-canvas border border-line rounded px-2 py-1.5 max-h-72 overflow-auto">
              {formatInput(call.input)}
            </pre>
          </Section>
          {call.output !== null && (
            <Section label="输出">
              <OutputView text={call.output} />
            </Section>
          )}
          {call.stderr && (
            <Section label="stderr">
              <pre className="text-label font-mono whitespace-pre-wrap break-words bg-danger-muted border border-danger-line rounded px-2 py-1.5 max-h-48 overflow-auto text-danger-ink">
                {call.stderr}
              </pre>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-nano uppercase tracking-wider text-ink-faint mb-0.5">
        {label}
      </div>
      {children}
    </div>
  );
}

function StatusPill({ status }: { status: ToolCall["status"] }) {
  if (status === "running") {
    return (
      <Pill tone="warn" className="shrink-0">
        运行中
      </Pill>
    );
  }
  if (status === "error") {
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

// Long Bash logs clamp to MAX_OUTPUT_LINES with a one-click expand. The
// raw text is preserved in state so re-collapse just hides it again.
function OutputView({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split("\n");
  const tooLong = lines.length > MAX_OUTPUT_LINES;
  const shown = expanded || !tooLong ? text : lines.slice(0, MAX_OUTPUT_LINES).join("\n");
  return (
    <div>
      <pre className="text-label font-mono whitespace-pre-wrap break-words bg-surface-canvas border border-line rounded px-2 py-1.5 max-h-96 overflow-auto">
        {shown}
        {tooLong && !expanded && (
          <span className="text-ink-faint">
            {"\n…"}
          </span>
        )}
      </pre>
      {tooLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-label text-accent-ink hover:underline"
        >
          {expanded
            ? `收起（共 ${lines.length} 行）`
            : `展开剩余 ${lines.length - MAX_OUTPUT_LINES} 行`}
        </button>
      )}
    </div>
  );
}

function oneLineSummary(call: ToolCall): string {
  // Pull the most user-meaningful field from each tool's input. For
  // unknown tools fall back to a JSON one-liner truncated to ~80 chars.
  const i = call.input;
  if (i && typeof i === "object") {
    const o = i as Record<string, unknown>;
    if (typeof o.command === "string") return o.command; // Bash
    if (typeof o.file_path === "string") return o.file_path; // Read/Write/Edit
    if (typeof o.url === "string") return o.url; // WebFetch
    if (typeof o.query === "string") return o.query; // WebSearch/Grep
    if (typeof o.pattern === "string") return o.pattern; // Glob/Grep
    // Last resort before raw JSON: Agent/Task (and a few others) label
    // themselves here. Checked after `command` so Bash still shows its
    // command rather than its description.
    if (typeof o.description === "string") return o.description;
  }
  const flat = JSON.stringify(i);
  if (!flat) return "";
  return flat.length > 80 ? flat.slice(0, 80) + "…" : flat;
}

function formatInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}
