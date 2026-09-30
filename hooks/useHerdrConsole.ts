"use client";

import { useMemo } from "react";
import { herdrUnavailableText, useHerdrFleet } from "@/hooks/useHerdrFleet";
import {
  buildHerdrConsole,
  findConsolePaneForSession,
  herdrStripPanes,
  type HerdrConsolePane,
} from "@/lib/herdr-console";
import { useSessionStore } from "@/stores/sessionStore";
import { useHerdrConsoleStore } from "@/stores/herdrConsoleStore";

/** 操作台共用投影：fleet + hook 镜像 → 带泳道的窗格列表（含纯 shell 与离线会话）。 */
export function useHerdrConsole() {
  const snapshot = useHerdrFleet();
  const panes = useMemo(
    () => buildHerdrConsole(snapshot.fleet, snapshot.hooks),
    [snapshot.fleet, snapshot.hooks],
  );
  const strip = useMemo(() => herdrStripPanes(panes), [panes]);
  const available = Boolean(snapshot.fleet?.available && !snapshot.error);
  return {
    ...snapshot,
    panes,
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
