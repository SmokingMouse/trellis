"use client";

import { SquareTerminal } from "lucide-react";
import { Icon, IconButton } from "@/components/ui";
import { useHerdrConsoleStore } from "@/stores/herdrConsoleStore";

// 会话页标签条右端的终端抽屉开关（⌥` 同效）。
export function HerdrDrawerToggle() {
  const open = useHerdrConsoleStore((s) => s.drawerOpen && s.drawerPaneId === null);
  return (
    <IconButton
      label="终端抽屉：读屏 + 发按键"
      shortcut={["⌥", "`"]}
      size="sm"
      data-herdr-drawer-toggle
      aria-pressed={open}
      onClick={() => useHerdrConsoleStore.getState().toggleDrawer()}
      className={open ? "bg-surface-muted text-ink" : undefined}
    >
      <Icon icon={SquareTerminal} size="sm" />
    </IconButton>
  );
}
