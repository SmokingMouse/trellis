"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronLeft, ChevronRight, SquareTerminal } from "lucide-react";
import { Icon, cn } from "@/components/ui";
import { HerdrSwipeCard, swipeCardOwns } from "./HerdrSwipeCard";
import { openHerdrConsolePane, useCurrentHerdrPane, useHerdrConsole } from "@/hooks/useHerdrConsole";
import { overflowX, overflowY, useGesturesEnabled, usePrefersReducedMotion, useSwipe } from "@/hooks/useSwipe";
import {
  PULL_OPEN_DISTANCE,
  isEdgeStart,
  lockAxis,
  pullDistance,
  rubberBand,
  startsInHorizontalScroller,
  startsInScrolledInner,
} from "@/lib/gestures";
import { stepHerdrPane, type HerdrConsolePane } from "@/lib/herdr-console";
import { herdrGroupName } from "@/lib/herdr-mode";
import { useHerdrConsoleStore } from "@/stores/herdrConsoleStore";

const INDICATOR_LINGER_MS = 1_200;

type Indicator = { pane: HerdrConsolePane; dir: -1 | 0 | 1; edge: boolean; armed: boolean };

// Herdr 会话页的两个正文手势（只在手机 / 触屏启用，桌面不挂任何监听）：
//   ① 左右滑切窗格：与 ⌥[ ⌥] 同序（lib/herdr-console stepHerdrPane，不环绕）。左滑 = 下一个。
//      跟手位移 + 阈值（距离 28% 宽 / 速度 0.5px/ms）触发，不够回弹；到头了阻尼回弹。
//      起点在可横向滚动的元素里（代码块 / 表格）或可滑的审批卡上时不接管；
//      纵向优先：容器 touch-action: pan-y，浏览器先认纵向滚动，斜划归纵向（lockAxis）。
//   ② 顶部下拉开终端抽屉：只有正文 scrollTop=0 且起手就是往下拉才算；中途正文开始滚动即放弃。
//      这个手势要在「浏览器本来会做 overscroll」时抢过来，touch-action 表达不了，
//      所以走 touch 事件 + 非 passive touchmove preventDefault，只在已确认是下拉后才拦。
export function HerdrSessionGestures({
  scrollRef,
  contentRef,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLElement | null>;
}) {
  const gestures = useGesturesEnabled();
  const reduced = usePrefersReducedMotion();
  const hc = useHerdrConsole();
  const current = useCurrentHerdrPane(hc.panes);
  const drawerOpen = useHerdrConsoleStore((s) => s.drawerOpen);
  const enabled = gestures && Boolean(current);
  const bindKey = current?.key ?? null;
  const [indicator, setIndicator] = useState<Indicator | null>(null);
  const [pull, setPull] = useState<{ distance: number; armed: boolean } | null>(null);
  const lingerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ strip: hc.strip, current, drawerOpen, reduced });
  useEffect(() => {
    latest.current = { strip: hc.strip, current, drawerOpen, reduced };
  });

  // 让出横向手势：正文容器只把纵向平移交给浏览器。
  useEffect(() => {
    const el = scrollRef.current;
    if (!enabled || !el) return;
    const prev = el.style.touchAction;
    el.style.touchAction = "pan-y pinch-zoom";
    return () => {
      el.style.touchAction = prev;
    };
  }, [enabled, scrollRef, bindKey]);

  useEffect(
    () => () => {
      if (lingerTimer.current) clearTimeout(lingerTimer.current);
    },
    [],
  );

  const moveContent = (transform: string, animate: boolean, opacity?: number) => {
    const el = contentRef.current;
    if (!el) return;
    el.style.transition = animate && !latest.current.reduced ? "transform 180ms ease-out, opacity 180ms ease-out" : "none";
    el.style.transform = transform;
    el.style.opacity = opacity == null ? "" : String(opacity);
  };

  const linger = (pane: HerdrConsolePane) => {
    setIndicator({ pane, dir: 0, edge: false, armed: false });
    if (lingerTimer.current) clearTimeout(lingerTimer.current);
    lingerTimer.current = setTimeout(() => setIndicator(null), INDICATOR_LINGER_MS);
  };

  // ① 左右滑切窗格
  useSwipe(scrollRef, {
    enabled,
    bindKey,
    axis: "x",
    canStart: (e, el) => {
      if (latest.current.drawerOpen) return false;
      if (isEdgeStart(e.clientX)) return false; // 左缘右拉归侧栏（MobileEdgeSwipe）
      if (swipeCardOwns(e.target)) return false;
      return !startsInHorizontalScroller(e.target as HTMLElement, el, overflowX);
    },
    onMove: (delta) => {
      const { strip, current } = latest.current;
      if (!current) return;
      const dir: 1 | -1 = delta < 0 ? 1 : -1;
      const target = stepHerdrPane(strip, current.key, dir);
      if (lingerTimer.current) clearTimeout(lingerTimer.current);
      if (!target) {
        moveContent(`translateX(${rubberBand(delta)}px)`, false);
        setIndicator({ pane: current, dir, edge: true, armed: false });
        return;
      }
      const width = scrollRef.current?.clientWidth ?? 390;
      moveContent(`translateX(${delta}px)`, false, 1 - Math.min(0.4, Math.abs(delta) / width));
      setIndicator({ pane: target, dir, edge: false, armed: Math.abs(delta) >= Math.max(64, width * 0.28) });
    },
    onEnd: ({ commit, size }) => {
      const { strip, current } = latest.current;
      const target = commit !== 0 && current ? stepHerdrPane(strip, current.key, commit < 0 ? 1 : -1) : null;
      if (!target) {
        moveContent("", true);
        if (current) linger(current);
        return;
      }
      // 划出 → 切会话 → 从另一侧轻推回来
      moveContent(`translateX(${commit * size}px)`, true, 0);
      const swap = () => {
        openHerdrConsolePane(target);
        moveContent(`translateX(${-commit * 40}px)`, false, 0.4);
        requestAnimationFrame(() => requestAnimationFrame(() => moveContent("", true)));
        linger(target);
      };
      if (latest.current.reduced) swap();
      else setTimeout(swap, 160);
    },
  });

  // ② 顶部下拉开终端抽屉
  useEffect(() => {
    const el = scrollRef.current;
    if (!enabled || !el) return;
    let start: { x: number; y: number } | null = null;
    let phase: "pending" | "active" = "pending";
    let distance = 0;
    const stop = () => {
      start = null;
      if (phase === "active") {
        moveContent("", true);
        setPull(null);
      }
      phase = "pending";
      distance = 0;
    };
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (e.touches.length !== 1 || !t || latest.current.drawerOpen || el.scrollTop > 0) return;
      if (startsInScrolledInner(e.target as HTMLElement, el, overflowY)) return;
      start = { x: t.clientX, y: t.clientY };
      phase = "pending";
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (phase === "pending") {
        const axis = lockAxis(dx, dy);
        if (!axis) return;
        if (axis !== "y" || dy <= 0 || el.scrollTop > 0) {
          start = null;
          return;
        }
        phase = "active";
      }
      if (!e.cancelable) {
        stop();
        return;
      }
      e.preventDefault();
      distance = pullDistance(dy);
      moveContent(`translateY(${distance}px)`, false);
      setPull({ distance, armed: distance >= PULL_OPEN_DISTANCE });
    };
    const onEnd = () => {
      const armed = phase === "active" && distance >= PULL_OPEN_DISTANCE;
      stop();
      if (armed) useHerdrConsoleStore.getState().openDrawer(null);
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", stop);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", stop);
    };
    // moveContent 只读 ref，不需要进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, scrollRef, bindKey]);

  if (!enabled) return null;
  return (
    <>
      {pull && (
        <div
          data-herdr-pull-hint={pull.armed ? "armed" : "pulling"}
          aria-hidden
          className="pointer-events-none fixed inset-x-0 z-30 flex justify-center"
          style={{ top: `calc(var(--trellis-header-h) + ${Math.max(4, pull.distance / 2 - 14)}px)` }}
        >
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-label shadow-pop",
              pull.armed ? "border-accent bg-accent text-accent-fg" : "border-line bg-surface-raised text-ink-muted",
            )}
          >
            <Icon icon={SquareTerminal} size="sm" />
            {pull.armed ? "松手打开终端" : "下拉打开终端"}
          </span>
        </div>
      )}
      {indicator && <PaneIndicator indicator={indicator} strip={hc.strip} groupName={groupNameOf(hc.groups, indicator.pane)} />}
    </>
  );
}

function groupNameOf(groups: ReturnType<typeof useHerdrConsole>["groups"], pane: HerdrConsolePane): string {
  const g = groups.find((group) => group.rows.some((r) => r.pane.key === pane.key));
  return g ? herdrGroupName(g) : pane.workspaceLabel;
}

function PaneIndicator({ indicator, strip, groupName }: { indicator: Indicator; strip: HerdrConsolePane[]; groupName: string }) {
  const { pane, dir, edge, armed } = indicator;
  const index = strip.findIndex((p) => p.key === pane.key);
  let text: ReactNode;
  if (edge) text = dir === 1 ? "已是最后一个窗格" : "已是第一个窗格";
  else
    text = (
      <>
        <span className="min-w-0 truncate font-medium">{groupName}</span>
        <span className="shrink-0 tabular-nums text-ink-faint">
          · 第 {index + 1}/{strip.length}
        </span>
      </>
    );
  return (
    <div
      role="status"
      aria-live="polite"
      data-herdr-swipe-indicator={edge ? "edge" : armed ? "armed" : dir === 0 ? "settled" : "dragging"}
      className="pointer-events-none fixed inset-x-0 z-40 flex justify-center px-6"
      style={{ top: "calc(var(--trellis-header-h) + 0.5rem)" }}
    >
      <span
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-label shadow-pop",
          armed ? "border-accent bg-accent-muted text-ink-strong" : "border-line bg-surface-raised text-ink",
        )}
      >
        {dir === -1 && <Icon icon={ChevronLeft} size="sm" className="shrink-0 text-ink-faint" />}
        {text}
        {dir === 1 && <Icon icon={ChevronRight} size="sm" className="shrink-0 text-ink-faint" />}
      </span>
    </div>
  );
}

/** 会话页顶部的「需要你」卡外层：拿当前窗格给滑动 / 长按用，卡片本身原样渲染。 */
export function HerdrSessionSwipeCard({ children }: { children: ReactNode }) {
  const hc = useHerdrConsole();
  const current = useCurrentHerdrPane(hc.panes);
  return (
    <HerdrSwipeCard
      pane={current}
      readOnly={hc.readOnly}
      available={hc.available}
      where={current ? `${current.workspaceLabel} · ${current.tabLabel}` : undefined}
    >
      {children}
    </HerdrSwipeCard>
  );
}
