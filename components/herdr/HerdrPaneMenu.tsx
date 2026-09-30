"use client";

import type { ReactNode } from "react";
import { Ellipsis, MessageSquare, Pin, PinOff, SquareTerminal, Crosshair, type LucideIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icon,
  cn,
  toast,
} from "@/components/ui";
import {
  ContextMenu,
  useContextMenuWithTarget,
  type ContextMenuItem,
  type ContextMenuTriggerBindings,
} from "@/components/ui/ContextMenu";
import type { HerdrConsolePane } from "@/lib/herdr-console";
import { focusHerdrPane } from "@/lib/herdr-actions";
import { openHerdrConsolePane } from "@/hooks/useHerdrConsole";
import { useSessionStore } from "@/stores/sessionStore";
import { useHerdrConsoleStore } from "@/stores/herdrConsoleStore";

// 卡片 ⋯ 菜单：打开会话 / 置顶 / 在 Herdr 终端里切过去 / 看原始输出。
// 「在终端里切焦点」是次要项 —— 主路径是点卡片在 Trellis 里打开。
// 手机长按（卡片 / 窗格行 / 侧栏行）弹的是同一份菜单项（useHerdrPaneMenuItems），只是换成
// 锚在手指位置的 ContextMenu。
export type HerdrPaneMenuItem = {
  key: "open" | "pin" | "focus" | "raw";
  label: string;
  icon: LucideIcon;
  disabled: boolean;
  hint?: string;
  onSelect: () => void;
};

export function useHerdrPaneMenuItems(pane: HerdrConsolePane, readOnly: boolean, available: boolean): HerdrPaneMenuItem[] {
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
  return [
    {
      key: "open",
      label: pane.sessionId ? "打开会话" : "打开终端",
      icon: pane.sessionId ? MessageSquare : SquareTerminal,
      disabled: false,
      onSelect: () => openHerdrConsolePane(pane),
    },
    { key: "pin", label: pinned ? "取消置顶" : "置顶", icon: pinned ? PinOff : Pin, disabled: !pane.sessionId, onSelect: togglePin },
    {
      key: "focus",
      label: "在 Herdr 终端里切过去",
      icon: Crosshair,
      disabled: !live || !available || readOnly,
      hint: readOnly ? "只读" : undefined,
      onSelect: () => void focus(),
    },
    {
      key: "raw",
      label: "看原始输出",
      icon: SquareTerminal,
      disabled: !live || !available,
      onSelect: () => useHerdrConsoleStore.getState().openDrawer(pane.paneId),
    },
  ];
}

/**
 * 手机长按弹窗格菜单：返回要展开到目标元素上的触摸绑定 + 要渲染的菜单节点。
 * enabled=false（桌面）时绑定为空对象，桌面行为不变。
 */
export function useHerdrPaneLongPress(
  pane: HerdrConsolePane | null,
  readOnly: boolean,
  available: boolean,
  enabled: boolean,
  /** 选完菜单项后（侧栏抽屉里要顺手收起抽屉） */
  onAfterSelect?: () => void,
): { bind: Partial<ContextMenuTriggerBindings>; menu: ReactNode } {
  const menu = useContextMenuWithTarget<string>();
  const items = useHerdrPaneMenuItems(
    pane ?? PLACEHOLDER_PANE,
    readOnly,
    available,
  );
  const menuItems: ContextMenuItem[] = items.map((item) => ({
    label: item.label,
    icon: <Icon icon={item.icon} size="sm" />,
    disabled: item.disabled,
    hint: item.hint,
    onSelect: () => {
      item.onSelect();
      onAfterSelect?.();
    },
  }));
  if (!pane || !enabled) return { bind: {}, menu: null };
  const { onContextMenu: _desktopRightClick, ...touch } = menu.bindTrigger(pane.key);
  void _desktopRightClick;
  return {
    bind: touch,
    menu: <ContextMenu {...menu.props} items={menuItems} label={`${pane.title} 菜单`} />,
  };
}

// 仅用于让 hook 调用顺序稳定（pane 为 null 时不渲染菜单）
const PLACEHOLDER_PANE = {
  key: "",
  paneId: "",
  lane: "off",
  workspaceLabel: "",
  tabLabel: "",
  title: "",
  sessionId: null,
} as unknown as HerdrConsolePane;

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
  const items = useHerdrPaneMenuItems(pane, readOnly, available);
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
        {items.map((item) => (
          <DropdownMenuItem
            key={item.key}
            icon={<Icon icon={item.icon} />}
            disabled={item.disabled}
            shortcut={item.hint}
            onSelect={item.onSelect}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
