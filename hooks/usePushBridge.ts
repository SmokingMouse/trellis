"use client";
import { useEffect, useRef } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { PRESENCE_BEAT_MS } from "@/lib/push";
import { registerPushWorker } from "@/lib/push-client";
import { uuid } from "@/lib/uuid";

// 主界面与 Web Push 的两条桥：
//
// ① 点通知直达：public/sw.js 的 notificationclick 找到停在 / 的窗口时，不整页重载，
//    而是 postMessage「打开会话 X」，这里接住走 previewSession（与 ?session= 深链同一条路）。
// ② 前台心跳：当前会话在前台可见时，每 PRESENCE_BEAT_MS 报一次 /api/push/presence，
//    页面隐藏 / 切会话 / 卸载时立刻报「不看了」。服务端据此不给「你正盯着的会话」推手机
//    （lib/server/push.ts gate）。选服务端判定而不是 SW 里 clients.matchAll 判焦点：
//    iOS 对收到推送却不弹通知的 SW 会吊销订阅，所以 SW 必须每条都显示，只能在发送前拦。
export function usePushBridge(): void {
  const sessionId = useSessionStore((s) => s.session?.id ?? null);
  const clientIdRef = useRef<string | null>(null);

  // SW 每次打开主界面都注册一次（幂等）：保证脚本更新能被拉到，也让 sw.js 的消息有人收。
  useEffect(() => {
    void registerPushWorker();
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; sessionId?: string; nodeId?: string | null } | null;
      if (data?.type !== "trellis-open-session" || !data.sessionId) return;
      const st = useSessionStore.getState();
      const nodeId = data.nodeId;
      void st.previewSession(data.sessionId).then(() => {
        if (nodeId) useSessionStore.getState().setActiveNode(nodeId);
      });
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    clientIdRef.current ??= uuid();
    const clientId = clientIdRef.current;
    const report = (visible: boolean, beacon = false) => {
      const body = JSON.stringify({ clientId, sessionId, visible });
      if (beacon && navigator.sendBeacon?.("/api/push/presence", body)) return;
      void fetch("/api/push/presence", { method: "POST", body, keepalive: true }).catch(() => {});
    };
    let timer: ReturnType<typeof setInterval> | null = null;
    const sync = () => {
      const visible = document.visibilityState === "visible" && !!sessionId;
      if (timer) clearInterval(timer);
      timer = null;
      if (visible) {
        report(true);
        timer = setInterval(() => report(true), PRESENCE_BEAT_MS);
      } else {
        report(false, true);
      }
    };
    sync();
    const onHide = () => report(false, true);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("pagehide", onHide);
      if (timer) clearInterval(timer);
      // 切会话：旧会话立刻「不看了」，新会话的 effect 马上会再报一次可见。
      report(false, true);
    };
  }, [sessionId]);
}
