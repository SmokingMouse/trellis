"use client";
import type { ReactNode } from "react";
import type { ToolNode } from "@/lib/tool-tree";
import { OutputView, Section } from "../RawView";

// A real sub-agent (task_type: local_agent): the task it was handed, the tool
// chain it ran, and the report it came back with.
//
// `children` is the nested rows, pre-rendered by ToolRow — passing them in
// rather than importing ToolRow keeps the view registry free of a cycle.

export function SubagentView({
  node,
  children,
}: {
  node: ToolNode;
  children?: ReactNode;
}) {
  const { meta } = node;
  return (
    <>
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

      {node.children.length > 0 ? (
        // Left rail = "these belong to the sub-agent, not the main chain".
        <div className="border-l-2 border-line ml-1 pl-2">
          <div className="text-nano uppercase tracking-wider text-ink-faint mb-0.5">
            它的工具链 · {node.children.length}
          </div>
          <div className="border border-line rounded divide-y divide-line/70 overflow-hidden">
            {children}
          </div>
        </div>
      ) : (
        <div className="text-label text-ink-faint italic">
          {node.running ? "还没开始调工具…" : "没有调用工具"}
        </div>
      )}

      {node.report && (
        <Section label="📄 它交回的报告">
          <OutputView text={node.report} />
        </Section>
      )}
    </>
  );
}
