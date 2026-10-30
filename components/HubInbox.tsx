"use client";

import { CircleCheck, CircleHelp, Server } from "lucide-react";
import { Icon, PixelLoader, StatusDot } from "@/components/ui";
import { goHref } from "@/lib/gw-client";
import { sessionPath, type InboxItem, type InboxNode } from "@/lib/hub-fanout";

// 侧栏「其他机器」收件箱的行（数据见 hooks/useHubNodes.ts useHubInbox，合并规则见 lib/hub-fanout.ts）。
// 分组头由 SessionSidebar 的 GroupRow 画，这里只画行：行首状态槽（同侧栏会话行的语言：
// 等你回答 = 问号、在跑 = 像素格、刚完成 = 勾）+ 会话标题 + 行尾机器名。
// 点击是真链接（<a href>）：整页走 /__gw/go/<node>/?session=…，换后端、客户端状态清干净。
// 离线 / 拉取失败的机器各占一行灰态，不可点。

const STATUS_LABEL: Record<InboxItem["status"], string> = {
  waiting: "等你回答",
  running: "生成中",
  done: "刚完成",
};

function itemLabel(item: InboxItem): string {
  const status = item.status === "waiting" && item.kind === "approval" ? "等你审批" : STATUS_LABEL[item.status];
  return `${item.node} · ${item.title} · ${status}`;
}

const ROW = "h-7.5 max-md:h-11 mx-1 flex items-center gap-1.5 overflow-hidden rounded-field pr-1.5";

export function HubInboxRows({ items, unavailable, padLeft }: {
  items: InboxItem[];
  unavailable: InboxNode[];
  padLeft: number;
}) {
  return (
    <ul aria-label="其他机器的待处理" className="list-none">
      {items.map((item) => (
        <li key={`${item.node}:${item.sessionId}`}>
          <a
            href={goHref(item.node, sessionPath(item.sessionId, item.nodeId))}
            data-hub-inbox-row
            data-hub-node={item.node}
            data-hub-status={item.status}
            data-glide-row
            aria-label={`${itemLabel(item)}，打开（切到这台机器）`}
            title={`${itemLabel(item)}${item.summary ? `\n${item.summary}` : ""}\n点击切到 ${item.node} 打开`}
            style={{ paddingLeft: padLeft }}
            className={`${ROW} press-row font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink`}
          >
            <span aria-hidden className="flex w-3.5 shrink-0 items-center justify-center">
              {item.status === "waiting" ? (
                <Icon icon={CircleHelp} size="sm" className="text-accent-ink" />
              ) : item.status === "running" ? (
                <PixelLoader size="sm" label={null} />
              ) : (
                <Icon icon={CircleCheck} size="sm" className="text-ink-faint" />
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-ui">
              {item.title}
              {item.summary && (
                <span className="hidden truncate text-nano font-normal text-ink-faint max-md:block">{item.summary}</span>
              )}
            </span>
            <NodeChip name={item.node} />
          </a>
        </li>
      ))}
      {unavailable.map((n) => (
        <li
          key={`off:${n.node}`}
          data-hub-inbox-unavailable={n.node}
          style={{ paddingLeft: padLeft }}
          className={`${ROW} text-ink-faint opacity-60`}
          title={n.status === "offline" ? `${n.node} 离线` : `${n.node} 拉取失败${"error" in n && n.error ? `：${n.error}` : ""}`}
        >
          <span aria-hidden className="flex w-3.5 shrink-0 items-center justify-center">
            <StatusDot tone="neutral" />
          </span>
          <span className="min-w-0 flex-1 truncate text-ui">{n.status === "offline" ? "离线" : "暂时连不上"}</span>
          <NodeChip name={n.node} />
        </li>
      ))}
    </ul>
  );
}

// 行尾机器名：与会话行的工作区标签同款（muted 底 + 发丝环 + 等宽小字）。
export function NodeChip({ name }: { name: string }) {
  return (
    <span
      className="inline-flex max-w-[6rem] shrink-0 items-center gap-1 rounded-[4px] bg-surface-muted px-1 font-mono text-nano font-normal text-ink-faint shadow-hairline"
      title={`机器：${name}`}
    >
      <Icon icon={Server} size="sm" className="size-2.5 shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}
