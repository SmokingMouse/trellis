"use client";

import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Icon, cn } from "@/components/ui";
import { usePrefersReducedMotion } from "@/hooks/useSwipe";
import { lockAxis, pullDistance } from "@/lib/gestures";

// 自绘下拉刷新：html/body 锁了 overscroll（app/globals.css），standalone PWA 下没有系统刷新入口。
// 滚动容器已在顶部时继续下拉 → 列表跟着阻尼下移、顶部露出圆形指示器（箭头随拉距旋转）；
// 过阈值松手 → 指示器停在原位转圈，直到 onRefresh 的 promise 结束再收回。
// 只认触摸（touch 事件），纵向锁轴后才接管；横向起手（会话行左右滑、抽屉左拖）一律放行。
export const PULL_REFRESH_THRESHOLD = 64;
const HOLD_AT = 48; // 刷新中指示器停的位置
const MIN_SPIN_MS = 450; // 太快结束会闪一下，至少转这么久
const MAX_WAIT_MS = 10_000; // 兜底：拉取卡死也收回

type Props = HTMLAttributes<HTMLDivElement> & {
  enabled: boolean;
  onRefresh: () => Promise<unknown>;
  children: ReactNode;
};

export function PullToRefresh({ enabled, onRefresh, className, children, ...rest }: Props) {
  const reduced = usePrefersReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pull, setPull] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef({ onRefresh, refreshing });
  useEffect(() => {
    latest.current = { onRefresh, refreshing };
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (!enabled || !el) return;
    let start: { x: number; y: number } | null = null;
    let phase: "pending" | "active" = "pending";
    let current = 0;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (e.touches.length !== 1 || !t || latest.current.refreshing || el.scrollTop > 0) return;
      start = { x: t.clientX, y: t.clientY };
      phase = "pending";
      current = 0;
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (phase === "pending") {
        const axis = lockAxis(dx, dy);
        if (!axis) return;
        // 横向 / 往上推 / 已经不在顶部：交还给行滑动 / 原生滚动
        if (axis !== "y" || dy <= 0 || el.scrollTop > 0) {
          start = null;
          return;
        }
        phase = "active";
        setDragging(true);
      }
      if (e.cancelable) e.preventDefault();
      current = pullDistance(dy);
      setPull(current);
    };
    const onEnd = () => {
      if (!start || phase !== "active") {
        start = null;
        return;
      }
      start = null;
      setDragging(false);
      if (current < PULL_REFRESH_THRESHOLD) {
        setPull(0);
        return;
      }
      setPull(HOLD_AT);
      setRefreshing(true);
      const began = Date.now();
      const done = () => {
        const wait = Math.max(0, MIN_SPIN_MS - (Date.now() - began));
        setTimeout(() => {
          setRefreshing(false);
          setPull(0);
        }, wait);
      };
      Promise.race([
        latest.current.onRefresh(),
        new Promise((resolve) => setTimeout(resolve, MAX_WAIT_MS)),
      ]).then(done, done);
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [enabled]);

  const progress = Math.min(1, pull / PULL_REFRESH_THRESHOLD);
  const armed = pull >= PULL_REFRESH_THRESHOLD;
  const motion = dragging || reduced ? "none" : "transform var(--dur-base) var(--ease-out)";
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {enabled && (pull > 0 || refreshing) && (
        <div
          data-pull-refresh={refreshing ? "refreshing" : armed ? "armed" : "pulling"}
          role={refreshing ? "status" : undefined}
          aria-label={refreshing ? "正在刷新会话列表" : undefined}
          className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center"
          style={{ transform: `translateY(${pull - 40}px)`, transition: motion }}
        >
          <span
            className={cn(
              "flex size-9 items-center justify-center rounded-full border border-line bg-surface-raised shadow-pop",
              armed || refreshing ? "text-ink" : "text-ink-faint",
            )}
            style={{ opacity: refreshing ? 1 : 0.4 + progress * 0.6 }}
          >
            <Icon
              icon={RefreshCw}
              size="sm"
              className={refreshing && !reduced ? "animate-spin" : undefined}
              style={refreshing ? undefined : { transform: `rotate(${progress * 270}deg)` }}
            />
          </span>
        </div>
      )}
      <div
        ref={scrollRef}
        {...rest}
        className={cn("min-h-0 flex-1", className)}
        style={pull > 0 ? { transform: `translateY(${pull}px)`, transition: motion } : { transition: motion }}
      >
        {children}
      </div>
    </div>
  );
}
