"use client";
import { useRouter } from "next/navigation";
import { AtSign, MessagesSquare, X } from "lucide-react";
import { useSessionStore } from "@/stores/sessionStore";
import { Icon } from "@/components/ui";
import { nodeRefLabel, parseNodeRefs, type NodeRef } from "@/lib/node-refs";

// `@` 引用其他会话 / 节点（lib/node-refs.ts）的两处展示：
//   - NodeRefChips：输入框里待发送的引用（可删除）；
//   - NodeRefCards：TurnCard 问题区里已发出的引用（点了跳到被引用的会话 / 节点）。

export function NodeRefChips({
  refs,
  onRemove,
}: {
  refs: NodeRef[];
  onRemove: (nodeId: string) => void;
}) {
  if (refs.length === 0) return null;
  return (
    <div data-node-ref-chips="" className="flex flex-wrap gap-1.5">
      {refs.map((r) => {
        const label = nodeRefLabel(r);
        return (
          <span
            key={r.nodeId}
            data-node-ref-chip={r.nodeId}
            className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-field border border-accent-line bg-accent-muted pl-2 text-label text-accent-ink"
          >
            <Icon icon={AtSign} size="sm" className="shrink-0" />
            <span className="min-w-0 truncate" title={`引用：${label}`}>
              {label}
            </span>
            <button
              type="button"
              aria-label={`移除引用：${label}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onRemove(r.nodeId)}
              className="inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded-field hover:bg-surface-hover max-md:min-h-11 max-md:min-w-11"
            >
              <Icon icon={X} size="sm" />
            </button>
          </span>
        );
      })}
    </div>
  );
}

/** 已发出问题里的引用卡；没有引用时不渲染。 */
export function NodeRefCards({ question }: { question: string }) {
  const router = useRouter();
  const openNodeInSession = useSessionStore((s) => s.openNodeInSession);
  const setViewMode = useSessionStore((s) => s.setViewMode);
  const { refs } = parseNodeRefs(question);
  if (refs.length === 0) return null;
  return (
    <div data-node-ref-cards="" className="mt-2 flex flex-wrap gap-1.5">
      {refs.map((r) => (
        <button
          key={r.nodeId}
          type="button"
          data-node-ref-card={r.nodeId}
          title={`跳到被引用的节点：${r.label}`}
          onClick={() => {
            setViewMode("linear");
            router.replace(`/?session=${encodeURIComponent(r.sessionId)}&node=${encodeURIComponent(r.nodeId)}`);
            void openNodeInSession(r.sessionId, r.nodeId);
          }}
          className="inline-flex max-w-full min-w-0 min-h-7 items-center gap-1.5 rounded-field bg-surface-raised shadow-btn px-2 text-label text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink max-md:min-h-11"
        >
          <Icon icon={MessagesSquare} size="sm" className="shrink-0 text-ink-faint" />
          <span className="shrink-0 text-ink-faint">引用</span>
          <span className="min-w-0 truncate font-medium">{r.label}</span>
        </button>
      ))}
    </div>
  );
}
