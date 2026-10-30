"use client";
import { Info } from "lucide-react";
import { Icon } from "@/components/ui";
import { clockLabel } from "@/lib/role-timeline";
import type { ChatNode } from "@/lib/types";

// 系统节点（lib/server/system-node.ts）的通用兜底卡：认不出的 meta.kind（跟进报告、群聊轮次结束
// 由别的包各自画专属卡）先按「标题 + 正文」画出来，不当成一轮问答、不给分叉 / 删除。
export function SystemNodeCard({ node }: { node: ChatNode }) {
  return (
    <div data-system-node-card={node.id} className="overflow-hidden rounded-card bg-surface-raised shadow-raise">
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-2">
        <Icon icon={Info} size="sm" className="text-ink-faint" />
        <span className="text-ui font-semibold text-ink-strong">{node.question}</span>
        <span className="ml-auto text-label tabular-nums text-ink-faint">{clockLabel(node.createdAt)}</span>
      </div>
      {node.response && (
        <div className="border-t border-line px-3.5 py-2.5 text-ui leading-relaxed whitespace-pre-line text-ink-muted">
          {node.response}
        </div>
      )}
    </div>
  );
}
