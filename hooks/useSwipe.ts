"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import {
  lockAxis,
  swipeCommit,
  velocityFrom,
  DEFAULT_SWIPE_THRESHOLD,
  type SwipeAxis,
  type SwipeThreshold,
} from "@/lib/gestures";

// 单轴跟手滑动（Pointer Events，只认 touch）：
//   pointerdown → canStart 过滤起点 → 位移过 slop 后锁方向（lib/gestures lockAxis，纵向优先）
//   → 锁到本轴才接管（setPointerCapture + onMove 跟手），锁到另一轴就放手给浏览器滚动
//   → 松手按距离 / 速度阈值判 1 / -1 / 0（回弹）。
// 浏览器原生滚动要靠 CSS touch-action 让出：水平手势的元素挂 `touch-action: pan-y pinch-zoom`，
// 纵向由浏览器滚、横向交给这里；浏览器接管平移时会发 pointercancel，这里按回弹处理。
// 内层横滚元素（代码块 / 表格）自己是滚动容器，touch-action 只算到最近的滚动容器为止，不受影响。

export type SwipeEnd = { delta: number; velocity: number; commit: -1 | 0 | 1; size: number };

export type SwipeOptions = {
  enabled: boolean;
  axis: SwipeAxis;
  /** 起点过滤：返回 false 本次不接管（起点在横滚元素里 / 边缘外 / 卡片不支持） */
  canStart?: (e: PointerEvent, el: HTMLElement) => boolean;
  /** 已锁定到本轴后每次移动；delta 是沿轴的原始位移（右 / 下为正） */
  onMove?: (delta: number) => void;
  onEnd?: (end: SwipeEnd) => void;
  /** 触发阈值按哪个尺寸算比例：默认元素本身沿轴尺寸 */
  size?: (el: HTMLElement) => number;
  threshold?: SwipeThreshold;
  /** 变化时重新绑定监听（目标元素可能随会话切换重新挂载） */
  bindKey?: string | null;
};

/** 仅在触屏设备（coarse pointer）或手机断点下启用手势；桌面鼠标永远不触发。 */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarse(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return coarse;
}

/** 手势总开关：手机断点（含「转桌面版」之外的真手机）或触屏设备；桌面鼠标环境恒为 false。 */
export function useGesturesEnabled(): boolean {
  const isMobile = useIsMobile();
  const coarse = useCoarsePointer();
  return isMobile === true || coarse;
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

export function useSwipe(ref: RefObject<HTMLElement | null>, options: SwipeOptions): void {
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const { enabled, bindKey } = options;

  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    let pointerId: number | null = null;
    let start = { x: 0, y: 0 };
    let phase: "idle" | "pending" | "active" = "idle";
    let samples: { t: number; v: number }[] = [];
    let suppressClick = false;

    const along = (e: PointerEvent) =>
      latest.current.axis === "x" ? e.clientX - start.x : e.clientY - start.y;
    const sizeOf = () => {
      const custom = latest.current.size;
      if (custom) return custom(el);
      return latest.current.axis === "x" ? el.clientWidth : el.clientHeight;
    };
    const reset = () => {
      if (pointerId !== null && el.hasPointerCapture?.(pointerId)) el.releasePointerCapture(pointerId);
      pointerId = null;
      phase = "idle";
      samples = [];
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !e.isPrimary || phase !== "idle") return;
      if (latest.current.canStart && !latest.current.canStart(e, el)) return;
      pointerId = e.pointerId;
      start = { x: e.clientX, y: e.clientY };
      phase = "pending";
      samples = [{ t: e.timeStamp, v: 0 }];
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId || phase === "idle") return;
      if (phase === "pending") {
        const axis = lockAxis(e.clientX - start.x, e.clientY - start.y);
        if (!axis) return;
        if (axis !== latest.current.axis) {
          reset();
          return;
        }
        phase = "active";
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* pointer 已经结束 */
        }
      }
      const delta = along(e);
      samples.push({ t: e.timeStamp, v: delta });
      if (samples.length > 12) samples.shift();
      latest.current.onMove?.(delta);
    };
    const finish = (e: PointerEvent, cancelled: boolean) => {
      if (e.pointerId !== pointerId) return;
      const wasActive = phase === "active";
      const delta = wasActive ? along(e) : 0;
      if (wasActive) samples.push({ t: e.timeStamp, v: delta });
      const velocity = velocityFrom(samples);
      const size = sizeOf();
      reset();
      if (!wasActive) return;
      suppressClick = !cancelled && Math.abs(delta) > 4;
      if (suppressClick) setTimeout(() => (suppressClick = false), 400);
      const commit = cancelled
        ? 0
        : swipeCommit({ delta, velocity, size }, latest.current.threshold ?? DEFAULT_SWIPE_THRESHOLD);
      latest.current.onEnd?.({ delta: cancelled ? 0 : delta, velocity, commit, size });
    };
    const onUp = (e: PointerEvent) => finish(e, false);
    const onCancel = (e: PointerEvent) => finish(e, true);
    // 划完松手时浏览器还会补一个 click：吞掉，免得划卡片顺带点开了会话。
    const onClickCapture = (e: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
    el.addEventListener("click", onClickCapture, true);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
      el.removeEventListener("click", onClickCapture, true);
      reset();
    };
  }, [ref, enabled, bindKey]);
}

/** 计算样式读取（给 lib/gestures 的起点判定用）。 */
export const overflowX = (el: Element) => getComputedStyle(el).overflowX;
export const overflowY = (el: Element) => getComputedStyle(el).overflowY;
