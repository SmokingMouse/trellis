"use client";

import { useEffect, useState } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { isEdgeStart, lockAxis, swipeCommit, velocityFrom } from "@/lib/gestures";
import { useSessionStore } from "@/stores/sessionStore";

const PANEL_MAX = 320;

// 手机：从屏幕左缘 20px 内起手往右拉 → 拉出侧栏抽屉（等同 Header 的「会话列表」按钮）。
// 全页面都要能起手，而普通内容是 touch-action: auto（浏览器会接管平移并 pointercancel），
// 所以这里用 document 级 touch 事件：起点不在左缘直接忽略，确认是水平右拉后才 preventDefault。
// 跟手的是一块与抽屉同宽的预览板，过阈值松手才真正打开抽屉（抽屉自带滑入动画）。
// 已知限制：iOS Safari 浏览器内（非主屏 PWA）左缘右滑是系统「后退」，网页拦不住。
export function MobileEdgeSwipe() {
  const isMobile = useIsMobile();
  const navOpen = useSessionStore((s) => s.mobileNavOpen);
  // 抽屉只存在于手机断点；touch 事件本身只在触屏上出现，桌面鼠标永远到不了这里。
  const enabled = isMobile === true && !navOpen;
  const [offset, setOffset] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let start: { x: number; y: number } | null = null;
    let phase: "pending" | "active" = "pending";
    let samples: { t: number; v: number }[] = [];
    const panelWidth = () => Math.min(PANEL_MAX, window.innerWidth * 0.82);
    const reset = () => {
      start = null;
      phase = "pending";
      samples = [];
      setOffset(null);
    };
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (e.touches.length !== 1 || !t || !isEdgeStart(t.clientX)) return;
      // 有别的模态层（sheet / 对话框 / 菜单）开着时不抢
      if (document.querySelector('[role="dialog"][aria-modal="true"], [data-herdr-drawer]')) return;
      start = { x: t.clientX, y: t.clientY };
      phase = "pending";
      samples = [{ t: e.timeStamp, v: 0 }];
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (phase === "pending") {
        const axis = lockAxis(dx, dy);
        if (!axis) return;
        if (axis !== "x" || dx <= 0) {
          start = null;
          return;
        }
        phase = "active";
      }
      if (e.cancelable) e.preventDefault();
      samples.push({ t: e.timeStamp, v: dx });
      if (samples.length > 12) samples.shift();
      setOffset(Math.max(0, Math.min(panelWidth(), dx)));
    };
    const onEnd = (e: TouchEvent) => {
      if (!start || phase !== "active") {
        reset();
        return;
      }
      const t = e.changedTouches[0];
      const dx = t ? t.clientX - start.x : samples[samples.length - 1]?.v ?? 0;
      samples.push({ t: e.timeStamp, v: dx });
      const commit = swipeCommit({ delta: dx, velocity: velocityFrom(samples), size: panelWidth() });
      reset();
      if (commit > 0) useSessionStore.getState().setMobileNavOpen(true);
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", reset);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", reset);
      setOffset(null);
    };
  }, [enabled]);

  if (!enabled || offset === null) return null;
  const width = typeof window === "undefined" ? PANEL_MAX : Math.min(PANEL_MAX, window.innerWidth * 0.82);
  return (
    <div aria-hidden data-edge-swipe-preview className="pointer-events-none fixed inset-0 z-50 md:hidden">
      <div className="absolute inset-0 bg-scrim" style={{ opacity: (offset / width) * 0.5 }} />
      <div
        className="absolute bottom-0 left-0 top-0 border-r border-line bg-surface-canvas shadow-overlay"
        style={{ width, transform: `translateX(${offset - width}px)` }}
      />
    </div>
  );
}
