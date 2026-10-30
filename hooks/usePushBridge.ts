"use client";
import { useEffect, useRef } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { PRESENCE_BEAT_MS } from "@/lib/push";
import { registerPushWorker } from "@/lib/push-client";
import { herdrCardSelector, parsePushFocus, stripPushFocus, type PushFocus } from "@/lib/push-focus";

// 定位要等目标渲染出来（会话载入、fleet 首拉、总览泳道），等这么久还没有就算了。
const FOCUS_WAIT_MS = 15_000;
const FOCUS_POLL_MS = 200;

function highlight(el: HTMLElement): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  el.animate([{ boxShadow: "0 0 0 3px var(--accent)" }, { boxShadow: "0 0 0 0px transparent" }], { duration: 1800 });
}

/** 滚到通知指向的那张卡并聚焦（手机上一下就能答）。返回取消函数。 */
function revealPushFocus(focus: PushFocus): () => void {
  let stopped = false;
  const deadline = Date.now() + FOCUS_WAIT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const done = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    const next = stripPushFocus(window.location.href);
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next !== current) window.history.replaceState(window.history.state, "", next);
  };
  const tick = () => {
    if (stopped) return;
    const st = useSessionStore.getState();
    if (focus.pendingNode) {
      // 自起会话的待处理卡：交给 LinearThreadView 现成的 pendingNavigation（与「去处理」同一条路）。
      if (st.session?.id === focus.sessionId && st.activeNodeId === focus.pendingNode) {
        useSessionStore.setState((s) => ({
          viewMode: "linear",
          pendingNavigation: { nodeId: focus.pendingNode!, sequence: (s.pendingNavigation?.sequence ?? 0) + 1 },
        }));
        return done();
      }
    } else if (focus.paneId) {
      const card = document.querySelector<HTMLElement>(herdrCardSelector(focus.paneId));
      // 会话页还没切到目标会话时，底部那张可能是别的窗格的卡——选择器按窗格 id 认，不会认错。
      if (card && (!focus.sessionId || st.session?.id === focus.sessionId)) {
        card.scrollIntoView({ block: "center" });
        card.tabIndex = -1;
        card.focus({ preventScroll: true });
        highlight(card);
        return done();
      }
    }
    if (Date.now() > deadline) return done();
    timer = setTimeout(tick, FOCUS_POLL_MS);
  };
  // 晚一帧：让深链 / 站内切会话先把目标会话挂上。
  timer = setTimeout(tick, FOCUS_POLL_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

// 主界面与 Web Push 的两条桥：
//
// ① 点通知直达：public/sw.js 的 notificationclick 找到停在 / 的窗口时，不整页重载，
//    而是 postMessage「打开会话 X」，这里接住走 previewSession（与 ?session= 深链同一条路）。
//    通知 url 里的定位参数（?focus=pending / ?pane=，lib/push-focus.ts）——不论站内消息还是
//    整页落地（含经 hub 的 /__gw/go/<机器>/... 302 过来）——都在这里滚到并聚焦那张卡。
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
    let cancelReveal: (() => void) | null = null;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; sessionId?: string | null; nodeId?: string | null; url?: string } | null;
      if (data?.type !== "trellis-open-session") return;
      const focus = data.url ? parsePushFocus(new URL(data.url, window.location.origin).search) : null;
      const st = useSessionStore.getState();
      const nodeId = data.nodeId;
      cancelReveal?.();
      cancelReveal = null;
      if (data.sessionId) {
        void st.previewSession(data.sessionId).then(() => {
          if (nodeId) useSessionStore.getState().setActiveNode(nodeId);
          if (focus) cancelReveal = revealPushFocus(focus);
        });
      } else if (focus?.herdrView) {
        st.openHerdr();
        cancelReveal = revealPushFocus(focus);
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", onMessage);
      cancelReveal?.();
    };
  }, []);

  // 整页落地（冷启动点通知 / 经 hub 换机器）：深链本身（会话 / 总览）由 app/page.tsx 处理，
  // 这里只负责之后的定位。
  useEffect(() => {
    const initial = parsePushFocus(window.location.search);
    return initial ? revealPushFocus(initial) : undefined;
  }, []);

  useEffect(() => {
    clientIdRef.current ??= crypto.randomUUID();
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
