"use client";
import { ChevronRight, ListChecks } from "lucide-react";
import { useSessionStore } from "@/stores/sessionStore";
import { Icon, StatusDot, cn, type StatusTone } from "@/components/ui";
import { FOLLOW_STATE_LABEL, type FollowState, type RoleFollowItem } from "@/lib/role-follow";
import { clockLabel } from "@/lib/role-timeline";
import { MarkdownBody } from "@/lib/markdown-cache";
import type { ChatNode } from "@/lib/types";

// 「跟进我的会话」报告（role-follow 系统节点，docs/roles-p2.md C）：一张清单卡。
// 每行一个新进入「等你 / 卡住 / 失败 / 完成」的会话，点了在当前窗口打开它。
// 数据来自 node.meta.items；老节点 / meta 坏了退回渲染正文 markdown。

const TONE: Record<FollowState, StatusTone> = {
  waiting: "attention",
  stuck: "warn",
  failed: "danger",
  done: "positive",
};

const CHIP: Record<FollowState, string> = {
  waiting: "bg-warn-muted text-warn-ink",
  stuck: "bg-warn-muted text-warn-ink",
  failed: "bg-danger-muted text-danger-ink",
  done: "bg-positive-muted text-positive-ink",
};

function itemsOf(node: ChatNode): RoleFollowItem[] | null {
  const raw = (node.meta as { items?: unknown } | null | undefined)?.items;
  if (!Array.isArray(raw)) return null;
  return raw.filter(
    (i): i is RoleFollowItem =>
      !!i && typeof i === "object" && typeof (i as RoleFollowItem).state === "string" && (i as RoleFollowItem).state in FOLLOW_STATE_LABEL,
  );
}

export function RoleFollowCard({ node }: { node: ChatNode }) {
  const previewSession = useSessionStore((s) => s.previewSession);
  const items = itemsOf(node);
  return (
    <div
      data-role-follow-card={node.id}
      className="overflow-hidden rounded-card bg-surface-raised shadow-hairline"
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Icon icon={ListChecks} size="sm" className="shrink-0 text-accent-ink" />
        <span className="min-w-0 flex-1 truncate text-ui font-medium text-ink">{node.question}</span>
        <span className="shrink-0 text-label tabular-nums text-ink-faint">{clockLabel(node.createdAt)}</span>
      </div>
      {items && items.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line">
          {items.map((it) => {
            const body = (
              <>
                <StatusDot tone={TONE[it.state]} />
                <span className={cn("shrink-0 rounded-chip px-1.5 py-0.5 text-nano font-medium", CHIP[it.state])}>
                  {FOLLOW_STATE_LABEL[it.state]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui text-ink">{it.title || "未命名会话"}</span>
                  {it.detail && <span className="block truncate text-label text-ink-muted">{it.detail}</span>}
                </span>
                {it.sessionId && <Icon icon={ChevronRight} size="sm" className="shrink-0 text-ink-faint" />}
              </>
            );
            return (
              <li key={it.subject}>
                {it.sessionId ? (
                  <button
                    type="button"
                    data-role-follow-item={it.sessionId}
                    onClick={() => void previewSession(it.sessionId!)}
                    className="flex min-h-11 w-full items-center gap-2.5 px-3 py-2 text-left transition-colors duration-100 hover:bg-surface-hover"
                  >
                    {body}
                  </button>
                ) : (
                  <div className="flex min-h-11 items-center gap-2.5 px-3 py-2">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="px-3 py-2 text-ui">
          <MarkdownBody cacheKey={`follow:${node.id}`} content={node.response} />
        </div>
      )}
      <div className="border-t border-line bg-surface-muted px-3 py-1.5 text-label text-ink-faint">
        只报新进入这些状态的会话；没变化不出声
      </div>
    </div>
  );
}
