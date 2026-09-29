"use client";
import { useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { useButlerStore } from "@/stores/butlerStore";

// 管家会话的提案同步（无界面）。提案是管家 run 中途经 trellisctl 写进来的，
// 不走 SSE：有轮次在跑时 2 秒轮询一次（卡片在管家说完话之前就能冒出来），
// 平时只在轮次结束时拉一次。与 ButlerPanel 分开挂 —— 面板窄屏不渲染，卡片要。
export function ButlerChangesSync({ sessionId }: { sessionId: string }) {
  const refresh = useButlerStore((s) => s.refresh);
  const refreshRecent = useButlerStore((s) => s.refreshRecent);
  const streaming = useSessionStore((s) => Object.values(s.nodes).some((n) => n.status === "streaming"));
  const settled = useSessionStore((s) => Object.values(s.nodes).filter((n) => n.status !== "streaming").length);

  useEffect(() => {
    void refresh(sessionId);
    void refreshRecent();
  }, [sessionId, settled, refresh, refreshRecent]);

  useEffect(() => {
    if (!streaming) return;
    const t = window.setInterval(() => void refresh(sessionId), 2000);
    return () => window.clearInterval(t);
  }, [streaming, sessionId, refresh]);

  return null;
}
