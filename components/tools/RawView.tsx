"use client";
import { useState } from "react";
import { showResult } from "@/lib/tool-registry";
import type { ToolNode } from "@/lib/tool-tree";

// The universal fallback body: pretty-printed input, clamped output, stderr.
// Every tool without a custom view lands here, and every custom view degrades
// to here when the payload isn't the shape it expected — so the view registry
// can never leave a row blank.

const MAX_OUTPUT_LINES = 200;

export function RawView({ node }: { node: ToolNode }) {
  const { call } = node;
  return (
    <>
      <Section label="输入">
        <pre className="text-label font-mono whitespace-pre-wrap break-words bg-surface-canvas border border-line rounded px-2 py-1.5 max-h-72 overflow-auto">
          {formatInput(call.input)}
        </pre>
      </Section>
      {call.output !== null && showResult(call) && (
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
    </>
  );
}

export function Section({
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

// Long Bash logs clamp to MAX_OUTPUT_LINES with a one-click expand. The raw
// text is preserved in state so re-collapse just hides it again.
export function OutputView({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split("\n");
  const tooLong = lines.length > MAX_OUTPUT_LINES;
  const shown =
    expanded || !tooLong ? text : lines.slice(0, MAX_OUTPUT_LINES).join("\n");
  return (
    <div>
      <pre className="text-label font-mono whitespace-pre-wrap break-words bg-surface-canvas border border-line rounded px-2 py-1.5 max-h-96 overflow-auto">
        {shown}
        {tooLong && !expanded && <span className="text-ink-faint">{"\n…"}</span>}
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

export function formatInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}
