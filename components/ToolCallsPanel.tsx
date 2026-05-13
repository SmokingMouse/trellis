"use client";
import { useState } from "react";
import type { ToolCall } from "@/lib/types";

// Stage 17: collapsed visualization of every tool the model invoked
// during this turn. Sits above the markdown response in NodeFullView.
//
// Closed by default — most users just want the answer. Expanding the
// outer panel reveals one row per call (name + status pill + duration).
// Each row is its own disclosure that shows pretty-printed input and
// truncated output. Long outputs (Bash logs especially) clamp to
// MAX_OUTPUT_LINES and show a "展开 X 行" toggle.

const MAX_OUTPUT_LINES = 200;

export function ToolCallsPanel({ toolCalls }: { toolCalls: ToolCall[] }) {
  const [open, setOpen] = useState(false);
  if (toolCalls.length === 0) return null;

  const runningCount = toolCalls.filter((c) => c.status === "running").length;
  const errorCount = toolCalls.filter((c) => c.status === "error").length;

  return (
    <div className="mb-3 border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden bg-stone-50/60 dark:bg-stone-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-2 flex items-center gap-2 text-[12px] hover:bg-stone-100/80 dark:hover:bg-stone-800/60 transition-colors"
      >
        <span
          className="text-stone-400 dark:text-stone-500 transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0)" }}
          aria-hidden
        >
          ▸
        </span>
        <span className="font-medium text-stone-700 dark:text-stone-200">
          🔧 工具调用
        </span>
        <span className="text-stone-500 dark:text-stone-400 tabular-nums">
          {toolCalls.length}
        </span>
        {runningCount > 0 && (
          <span className="text-amber-600 dark:text-amber-400">
            · {runningCount} 进行中
          </span>
        )}
        {errorCount > 0 && (
          <span className="text-rose-600 dark:text-rose-400">
            · {errorCount} 失败
          </span>
        )}
        <span className="flex-1" />
        <span className="text-[10px] text-stone-400 dark:text-stone-500 hidden sm:inline">
          {open ? "收起" : "展开"}
        </span>
      </button>

      {open && (
        <div className="border-t border-stone-200 dark:border-stone-800 divide-y divide-stone-200/70 dark:divide-stone-800/60">
          {toolCalls.map((tc) => (
            <ToolCallRow key={tc.id} call={tc} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCallRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const summary = oneLineSummary(call);
  return (
    <div className="bg-white/60 dark:bg-stone-950/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-2 flex items-center gap-2 text-[12px] text-left hover:bg-stone-100/60 dark:hover:bg-stone-800/40 transition-colors"
      >
        <span
          className="text-stone-400 dark:text-stone-500 transition-transform shrink-0"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0)" }}
          aria-hidden
        >
          ▸
        </span>
        <StatusPill status={call.status} />
        <span className="font-mono text-stone-800 dark:text-stone-200 shrink-0">
          {call.name}
        </span>
        <span className="text-stone-500 dark:text-stone-400 truncate">
          {summary}
        </span>
        <span className="flex-1" />
        {call.durationMs !== null && (
          <span className="text-[10px] tabular-nums text-stone-400 dark:text-stone-500 shrink-0">
            {formatDuration(call.durationMs)}
          </span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2">
          <Section label="输入">
            <pre className="text-[11px] font-mono whitespace-pre-wrap break-words bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 rounded px-2 py-1.5 max-h-72 overflow-auto">
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
              <pre className="text-[11px] font-mono whitespace-pre-wrap break-words bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded px-2 py-1.5 max-h-48 overflow-auto text-rose-900 dark:text-rose-200">
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
      <div className="text-[10px] uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-0.5">
        {label}
      </div>
      {children}
    </div>
  );
}

function StatusPill({ status }: { status: ToolCall["status"] }) {
  if (status === "running") {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 shrink-0">
        运行中
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 shrink-0">
        失败
      </span>
    );
  }
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 shrink-0">
      完成
    </span>
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
      <pre className="text-[11px] font-mono whitespace-pre-wrap break-words bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 rounded px-2 py-1.5 max-h-96 overflow-auto">
        {shown}
        {tooLong && !expanded && (
          <span className="text-stone-400 dark:text-stone-500">
            {"\n…"}
          </span>
        )}
      </pre>
      {tooLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline"
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}
