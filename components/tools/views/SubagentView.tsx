"use client";
import type { ReactNode } from "react";
import type { ToolNode } from "@/lib/tool-tree";
import { OutputView, Section, StderrView } from "../RawView";

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
  // 整块挂在 ToolRow 的委派竖线上：竖线就是「这些归它，不归主链」，所以
  // 子调用直接铺成行 —— 不再加小标题、不再套边框卡片。description 已经是
  // 行头摘要，这里只放行头放不下的：完整任务、工具链、报告、错误输出。
  return (
    <>
      {meta.prompt && (
        <details className="px-3 pt-1 pb-0.5">
          <summary className="cursor-pointer select-none text-nano uppercase tracking-wider text-ink-faint hover:text-ink-muted">
            交给它的任务
          </summary>
          <pre className="mt-1 text-label font-mono whitespace-pre-wrap break-words bg-surface-canvas border border-line rounded px-2 py-1.5 max-h-60 overflow-auto">
            {meta.prompt}
          </pre>
        </details>
      )}

      {node.children.length > 0 ? (
        <div className="divide-y divide-line-faint">{children}</div>
      ) : (
        <div className="px-3 py-1 text-label text-ink-faint italic">
          {node.running ? "还没开始调工具…" : "没有调用工具"}
        </div>
      )}

      {(node.report || node.call.stderr) && (
        <div className="px-3 pt-1 pb-2 space-y-2">
          {node.report && (
            <Section label="它交回的报告">
              <OutputView text={node.report} />
            </Section>
          )}
          {/* 错误永不隐藏：子 Agent 挂掉时的 stderr 以前没有任何渲染路径。 */}
          {node.call.stderr && <StderrView text={node.call.stderr} />}
        </div>
      )}
    </>
  );
}
