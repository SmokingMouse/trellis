"use client";

import { Ellipsis, MessageSquare, Pin, PinOff, SquareTerminal, Crosshair } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icon,
  cn,
  toast,
} from "@/components/ui";
import type { HerdrConsolePane } from "@/lib/herdr-console";
import { focusHerdrPane } from "@/lib/herdr-actions";
import { openHerdrConsolePane } from "@/hooks/useHerdrConsole";
import { useSessionStore } from "@/stores/sessionStore";
import { useHerdrConsoleStore } from "@/stores/herdrConsoleStore";

// 卡片 ⋯ 菜单：打开会话 / 置顶 / 在 Herdr 终端里切过去 / 看原始输出。
// 「在终端里切焦点」是次要项 —— 主路径是点卡片在 Trellis 里打开。
export function HerdrPaneMenu({
  pane,
  readOnly,
  available,
  className,
}: {
  pane: HerdrConsolePane;
  readOnly: boolean;
  available: boolean;
  className?: string;
}) {
  const pinned = useSessionStore((s) => (pane.sessionId ? s.pinnedSessionIds.includes(pane.sessionId) : false));
  const live = pane.lane !== "off";
  const where = `${pane.workspaceLabel} · ${pane.tabLabel}`;
  const focus = async () => {
    try {
      await focusHerdrPane(pane.paneId);
      toast.success(`已在 Herdr 里切到 ${where}`);
    } catch (error) {
      toast.error("没能切过去", { description: error instanceof Error ? error.message : String(error) });
    }
  };
  const togglePin = () => {
    if (!pane.sessionId) return;
    const store = useSessionStore.getState();
    if (pinned) void store.unpinSession(pane.sessionId);
    else void store.pinSession(pane.sessionId, { load: false });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="窗格操作"
          title="窗格操作"
          data-herdr-pane-menu
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-muted hover:text-ink aria-expanded:bg-surface-muted max-md:size-11",
            className,
          )}
        >
          <Icon icon={Ellipsis} size="sm" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem
          icon={<Icon icon={pane.sessionId ? MessageSquare : SquareTerminal} />}
          onSelect={() => openHerdrConsolePane(pane)}
        >
          {pane.sessionId ? "打开会话" : "打开终端"}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={<Icon icon={pinned ? PinOff : Pin} />}
          disabled={!pane.sessionId}
          onSelect={togglePin}
        >
          {pinned ? "取消置顶" : "置顶"}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={<Icon icon={Crosshair} />}
          disabled={!live || !available || readOnly}
          shortcut={readOnly ? "只读" : undefined}
          onSelect={() => void focus()}
        >
          在 Herdr 终端里切过去
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={<Icon icon={SquareTerminal} />}
          disabled={!live || !available}
          onSelect={() => useHerdrConsoleStore.getState().openDrawer(pane.paneId)}
        >
          看原始输出
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
