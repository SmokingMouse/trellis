"use client";

import { useCallback, useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { Check, ChevronsUpDown, Server, Settings2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
  StatusDot,
} from "@/components/ui";
import { fetchNodes } from "@/lib/gw-client";
import type { GwNode } from "@/lib/gw-types";

// 侧栏顶部的机器切换器（多机互联）。桌面常驻栏与手机抽屉共用（SessionSidebar.renderPanel）。
//
// 只在「经 hub 访问、且至少有一台远端机器」时出现：直连单人版时 /__gw/api/nodes 落到
// Next 返回 404，这里静默不渲染，单机用户看不到多余的东西。
// 切换 = 整页导航到 /__gw/go/<node>/：换的是整个后端，客户端状态必须清干净；
// 落到对方首页而不是同路径——会话 id 只在各自机器上有意义。
//
// 形态照原型 .machine（docs/ui-redesign/mockups/08-beautiful-ui.html）：墨色 logo 方块 +
// 机器名 + 一行小字状态（在线点带光晕），右侧上下箭头；菜单里每台机器一行（方块 + 名 + 小字）。
// `fallback`：没有远端机器（或还没拉到列表）时渲染它。可以是函数，拿到 hub 报的当前机器
// （直连单人版为 null）——桌面侧栏顶部用它画同款 .machine 卡片（LocalMachineCard，点击回首页）。

const POLL_MS = 30_000;

export function NodeSwitcher({
  fallback = null,
}: { fallback?: ReactNode | ((current: GwNode | null) => ReactNode) } = {}) {
  const [nodes, setNodes] = useState<GwNode[] | null>(null);

  const load = useCallback((): Promise<void> => {
    return fetchNodes()
      .then(setNodes)
      .catch(() => setNodes(null));
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  if (!nodes || !nodes.some((n) => n.kind === "remote")) {
    if (typeof fallback !== "function") return <>{fallback}</>;
    return <>{fallback(nodes?.find((n) => n.current) ?? null)}</>;
  }
  const current = nodes.find((n) => n.current) ?? nodes[0];

  return (
    <DropdownMenu onOpenChange={(open) => open && void load()}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-node-switcher
          aria-label={`当前机器：${current.name}，点击切换`}
          className="press flex h-9 w-full min-w-0 items-center gap-2 rounded-field px-2 text-left text-ink transition-colors duration-100 hover:bg-surface-hover aria-expanded:bg-surface-hover max-md:h-auto max-md:min-h-11"
        >
          <MachineTile />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[14px] font-medium leading-tight text-ink">{current.name}</span>
            <span className="flex items-center gap-1.5 text-[11.5px] leading-tight text-ink-faint">
              <StatusDot tone={current.online ? "positive" : "neutral"} />
              <span className="truncate">
                {current.online ? "在线" : "离线"}
                {current.kind === "home" ? " · hub 本机" : ""}
              </span>
            </span>
          </span>
          <Icon icon={ChevronsUpDown} size="sm" className="shrink-0 text-ink-faint" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuLabel>切换机器</DropdownMenuLabel>
        {nodes.map((node) => (
          <DropdownMenuItem
            key={node.name}
            disabled={!node.online && !node.current}
            className="h-10 max-md:h-auto"
            icon={<MachineTile muted={!node.current} online={node.online} />}
            shortcut={
              node.current ? (
                <Icon icon={Check} size="sm" className="text-accent-ink" />
              ) : !node.online ? (
                "离线"
              ) : node.kind === "home" ? (
                "hub 本机"
              ) : null
            }
            onSelect={() => {
              if (!node.current) window.location.href = `/__gw/go/${encodeURIComponent(node.name)}/`;
            }}
          >
            <span className="font-medium">{node.name}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          icon={<Icon icon={Settings2} size="sm" />}
          onSelect={() => {
            window.location.href = "/settings/nodes";
          }}
        >
          管理机器…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// 没有远端机器时的本机卡片：与切换器同一副 .machine 外形（墨色方块 + 名字 + 「本机 · 在线」+
// 上下箭头），但没有菜单——点击行为由调用方给（桌面侧栏 = 回首页）。只在桌面常驻栏里出现。
export function LocalMachineCard({
  name,
  className = "",
  ...rest
}: ComponentProps<"button"> & { name: string }) {
  return (
    <button
      type="button"
      className={`flex h-9 w-full min-w-0 items-center gap-2 rounded-field px-2 text-left text-ink transition-colors duration-100 hover:bg-surface-hover ${className}`}
      {...rest}
    >
      <MachineTile />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[14px] font-medium leading-tight text-ink">{name}</span>
        <span className="flex items-center gap-1.5 text-[11.5px] leading-tight text-ink-faint">
          <StatusDot tone="positive" />
          <span className="truncate">本机 · 在线</span>
        </span>
      </span>
      <Icon icon={ChevronsUpDown} size="sm" className="shrink-0 text-ink-faint" />
    </button>
  );
}

// 机器方块：当前机器 = 墨色实底；菜单里的其它机器 = muted 底 + 发丝环，在线时角上一颗绿点。
function MachineTile({ muted = false, online = true }: { muted?: boolean; online?: boolean }) {
  return (
    <span
      aria-hidden
      className={`relative grid size-5.5 shrink-0 place-items-center rounded-chip ${
        muted ? "bg-surface-muted text-ink-muted shadow-hairline" : "bg-ink text-ink-inverse"
      }`}
    >
      <Icon icon={Server} size="sm" className="size-3.5" />
      {muted && online && (
        <span className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-positive ring-2 ring-surface-raised" />
      )}
    </span>
  );
}
