"use client";
import { useSessionStore } from "@/stores/sessionStore";
import { Button } from "./ui/Button";

// 错误降级：本轮虽然中断/出错，但该节点已有子节点 —— 用户已经用追问续跑
// 或另开分支绕过了它，红色横幅的「待处理」语义已经过时。降级成一条安静的
// 可展开备注：默认只占一行，展开才看到错误详情和重跑入口（重跑仍是原地
// 重置 + resume 同 lineage，partial 工具结果都在 jsonl 里，不会从零重来）。
export function SupersededErrorNotice({
  nodeId,
  errorMessage,
}: {
  nodeId: string;
  errorMessage: string | null;
}) {
  const retryNode = useSessionStore((s) => s.retryNode);
  const aborted = errorMessage === "aborted";
  return (
    <details
      className="mt-3 text-label text-ink-faint nodrag"
      onClick={(e) => e.stopPropagation()}
    >
      <summary className="cursor-pointer select-none inline-flex items-center gap-1.5 hover:text-ink-muted">
        <span className="text-warn-ink" aria-hidden>
          ⚠
        </span>
        <span>{aborted ? "本轮已手动停止" : "本轮中途中断"} · 后续已继续</span>
      </summary>
      <div className="mt-1.5 p-2 rounded bg-surface-muted border border-line text-ink-muted flex items-start gap-2">
        <div className="flex-1 break-words">
          {aborted ? "已停止生成" : `出错：${errorMessage}`}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            retryNode(nodeId);
          }}
          title="原地重跑本轮（已完成的工具结果仍在上下文里，不会从零重来）"
        >
          ↻ 重跑本轮
        </Button>
      </div>
    </details>
  );
}
