"use client";

import { useEffect } from "react";
import { useHerdrFleet } from "@/hooks/useHerdrFleet";
import { appModeFor, type AppMode } from "@/lib/herdr-mode";
import { useSessionStore } from "@/stores/sessionStore";

// 对话 / Herdr 模式 = 当前视图的投影（见 lib/herdr-mode.ts 顶部说明）。
// 不单独存一个开关：开着 Herdr 会话 / 总览就是 Herdr 模式，于是任何入口（⌥K、通知、
// URL、置顶）打开 Herdr 会话都自动切过去，打开普通会话自动切回来。

let lastChatSessionId: string | null = null;

export function useAppMode(): AppMode {
  const session = useSessionStore((s) => s.session);
  const herdrOpen = useSessionStore((s) => s.herdrOpen);
  const { fleet } = useHerdrFleet();
  const mode = appModeFor({ session, herdrOpen }, fleet);
  const sessionId = session?.id ?? null;
  // 记住最后一个普通会话：从 Herdr 切回对话时回到它，而不是丢到首页。
  useEffect(() => {
    if (mode === "chat" && sessionId) lastChatSessionId = sessionId;
  }, [mode, sessionId]);
  return mode;
}

/** 顶部切换：Herdr → 总览（Herdr 模式首页）；对话 → 上次的普通会话，没有就首页。 */
export function switchAppMode(target: AppMode): void {
  const store = useSessionStore.getState();
  if (target === "herdr") {
    store.openHerdr();
    return;
  }
  if (lastChatSessionId && lastChatSessionId !== store.session?.id) {
    void store.previewSession(lastChatSessionId);
    return;
  }
  store.openHome();
}
