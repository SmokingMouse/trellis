"use client";

import { useEffect } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { isEdgeStart, lockAxis, swipeCommit, velocityFrom } from "@/lib/gestures";
import { DRAWER_SWIPE_THRESHOLD, drawerWidth, emitNavDrag } from "@/lib/mobile-nav-drag";
import { useSessionStore } from "@/stores/sessionStore";

// 手机：从屏幕左缘 20px 内起手往右拉 → 拉出侧栏抽屉（等同 Header 的「会话列表」按钮）。
// 全页面都要能起手，而普通内容是 touch-action: auto（浏览器会接管平移并 pointercancel），
// 所以这里用 document 级 touch 事件：起点不在左缘直接忽略，确认是水平右拉后才 preventDefault。
// 这里只识别手势；跟手的是真抽屉（components/MobileNavDrawer），位移经 lib/mobile-nav-drag 送过去，
// 松手按抽屉宽度 40% / 甩动速度判开关，由抽屉从当前位置补间到终点。
// 已知限制：iOS Safari 浏览器内（非主屏 PWA）左缘右滑是系统「后退」，网页拦不住。
export function MobileEdgeSwipe() {
  const isMobile = useIsMobile();
  const navOpen = useSessionStore((s) => s.mobileNavOpen);
  // 抽屉只存在于手机断点；touch 事件本身只在触屏上出现，桌面鼠标永远到不了这里。
  const enabled = isMobile === true && !navOpen;

  useEffect(() => {
    if (!enabled) return;
    let start: { x: number; y: number } | null = null;
    let phase: "pending" | "active" = "pending";
    let samples: { t: number; v: number }[] = [];
    const panelWidth = () => drawerWidth(window.innerWidth);
    const reset = () => {
      start = null;
      phase = "pending";
      samples = [];
    };
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (e.touches.length !== 1 || !t || !isEdgeStart(t.clientX)) return;
      // 有别的模态层（sheet / 对话框 / 菜单 / 正在收起的抽屉）开着时不抢
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
        emitNavDrag({ type: "start" });
      }
      if (e.cancelable) e.preventDefault();
      samples.push({ t: e.timeStamp, v: dx });
      if (samples.length > 12) samples.shift();
      emitNavDrag({ type: "move", offset: Math.max(0, Math.min(panelWidth(), dx)) });
    };
    const onEnd = (e: TouchEvent) => {
      if (!start || phase !== "active") {
        reset();
        return;
      }
      const t = e.changedTouches[0];
      const dx = t ? t.clientX - start.x : samples[samples.length - 1]?.v ?? 0;
      samples.push({ t: e.timeStamp, v: dx });
      const commit = swipeCommit(
        { delta: dx, velocity: velocityFrom(samples), size: panelWidth() },
        DRAWER_SWIPE_THRESHOLD,
      );
      reset();
      emitNavDrag({ type: "end", open: commit > 0 });
    };
    const onCancel = () => {
      const wasActive = start !== null && phase === "active";
      reset();
      if (wasActive) emitNavDrag({ type: "cancel" });
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onCancel);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onCancel);
      onCancel();
    };
  }, [enabled]);

  return null;
}
