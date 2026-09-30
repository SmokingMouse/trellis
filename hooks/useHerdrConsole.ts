"use client";

import { useCallback, useMemo } from "react";
import { herdrUnavailableText, useHerdrFleet } from "@/hooks/useHerdrFleet";
import {
  buildHerdrConsole,
  findConsolePaneForSession,
  type HerdrConsolePane,
} from "@/lib/herdr-console";
import { applyHerdrTitles, buildHerdrModeGroups, herdrModeStrip } from "@/lib/herdr-mode";
import { useSessionTitlesStore } from "@/stores/sessionTitlesStore";
import { useSessionStore } from "@/stores/sessionStore";
import { useHerdrConsoleStore } from "@/stores/herdrConsoleStore";

/** 操作台共用投影：fleet + hook 镜像 → 带泳道的窗格列表（含纯 shell 与离线会话）。 */
export function useHerdrConsole() {
  const snapshot = useHerdrFleet();
  // 标题统一走 lib/herdr-mode.ts 的 herdrPaneTitle：侧栏、窗格条、⌥K、总览卡片、跨窗格通知
  // 都从这里拿 panes，不会再各自出现「Claude Code」。
  const titles = useSessionTitlesStore((s) => s.titles);
  const sessionTitle = useCallback((id: string) => titles[id] ?? null, [titles]);
  const panes = useMemo(
    () => applyHerdrTitles(buildHerdrConsole(snapshot.fleet, snapshot.hooks), sessionTitle),
    [snapshot.fleet, snapshot.hooks, sessionTitle],
  );
  // 窗格条 / ⌥1-9 / ⌥J 的顺序跟 Herdr 模式的分组走（组序 → 组内 tab 序），与侧栏、标签行一致。
  const groups = useMemo(() => buildHerdrModeGroups(snapshot.fleet, panes, sessionTitle), [snapshot.fleet, panes, sessionTitle]);
  const strip = useMemo(() => herdrModeStrip(groups), [groups]);
  const available = Boolean(snapshot.fleet?.available && !snapshot.error);
  return {
    ...snapshot,
    panes,
    groups,
    strip,
    available,
    readOnly: Boolean(snapshot.fleet?.readOnly),
    unavailableText: herdrUnavailableText(snapshot),
  };
}

/** 当前会话对应的活窗格（非 Herdr 会话 / 离线为 null）。 */
export function useCurrentHerdrPane(panes: HerdrConsolePane[]): HerdrConsolePane | null {
  const sessionId = useSessionStore((s) => s.session?.id ?? null);
  return useMemo(() => findConsolePaneForSession(panes, sessionId), [panes, sessionId]);
}

/**
 * 打开一个窗格：有绑定会话 → 在工作台主区打开该会话；纯 shell / 无绑定 → 终端抽屉。
 * 走 previewSession（占预览标签位），和侧栏单击一致。
 */
export function openHerdrConsolePane(pane: HerdrConsolePane): void {
  const drawer = useHerdrConsoleStore.getState();
  drawer.clearFlash(pane.key);
  if (drawer.notice?.key === pane.key) drawer.dismissNotice();
  if (pane.sessionId) {
    if (drawer.drawerPaneId) drawer.closeDrawer();
    void useSessionStore.getState().previewSession(pane.sessionId);
    return;
  }
  drawer.openDrawer(pane.paneId);
}
