"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronsUpDown, Settings2 } from "lucide-react";
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

const POLL_MS = 30_000;

export function NodeSwitcher() {
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

  if (!nodes || !nodes.some((n) => n.kind === "remote")) return null;
  const current = nodes.find((n) => n.current) ?? nodes[0];

  return (
    <DropdownMenu onOpenChange={(open) => open && void load()}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-node-switcher
          aria-label={`当前机器：${current.name}，点击切换`}
          className="flex w-full min-h-8 items-center gap-2 rounded-field border border-line bg-surface px-2 text-ui text-ink transition-colors hover:bg-surface-hover max-md:min-h-11"
        >
          <StatusDot tone={current.online ? "positive" : "neutral"} />
          <span className="text-label text-ink-muted">机器</span>
          <span className="min-w-0 flex-1 truncate text-left font-mono font-medium text-ink-strong">
            {current.name}
          </span>
          <Icon icon={ChevronsUpDown} size="sm" className="text-ink-faint" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuLabel>切换机器</DropdownMenuLabel>
        {nodes.map((node) => (
          <DropdownMenuItem
            key={node.name}
            disabled={!node.online && !node.current}
            icon={<StatusDot tone={node.online ? "positive" : "neutral"} />}
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
            <span className="font-mono">{node.name}</span>
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
