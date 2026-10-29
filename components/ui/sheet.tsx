"use client";
import { useEffect, useMemo, useRef, useSyncExternalStore, type HTMLAttributes } from "react";
import { cn } from "./cn";

// 手机 sheet 体系的公共小件（Drawer / Modal / ActionSheet / ConfirmDialog 共用）。
//
// 断点只看物理视口宽度，与 CSS 的 sm: / md: 同一条线（不吃「桌面模式」覆盖：
// 原先这些原语的手机形态本来就是 CSS 断点驱动的）。
export const SHEET_DRAWER_QUERY = "(max-width: 639.98px)"; // Drawer：< sm
export const SHEET_MODAL_QUERY = "(max-width: 767.98px)"; // Modal / Confirm / 菜单：< md

/** sheet 退场时长（ms），与 globals.css 里 .ui-sheet* 的 --dur-base 对齐 */
export const SHEET_EXIT_MS = 200;

const subscribeMedia = (query: string) => (onChange: () => void) => {
  const mq = window.matchMedia(query);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
};

/** 媒体查询订阅；SSR / hydrate 前返回 false（= 桌面形态），挂载后再切。 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useMemo(() => subscribeMedia(query), [query]);
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** 顶部把手：纯视觉 + 拖拽起手区，读屏忽略。 */
export function SheetGrabber({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      data-sheet-grabber
      className={cn("flex h-5 shrink-0 items-center justify-center", className)}
      {...rest}
    >
      <span className="h-[5px] w-9 rounded-pill bg-ink-faint/40" />
    </div>
  );
}

/**
 * vaul sheet 里的竖向手势归属。sheet 内的可滚动区是 touch-action:auto，浏览器一接管
 * 平移就发 pointercancel，vaul 收不到后续 pointermove，「滚到顶再下拉」拖不动 sheet。
 * 这里在第一个竖向 touchmove 上判归属，归 sheet 就 preventDefault（整段手势都拦）：
 *   - claimAll() 为真（Drawer 默认档：先展开再滚动）→ 归 sheet；
 *   - 触点下没有可滚动容器 → 归 sheet；
 *   - 向下拉且容器已滚到顶 → 归 sheet；
 *   - 其余（往上滚 / 容器不在顶）→ 原生滚动。横向手势（代码块横滚）不管。
 */
export function useSheetTouchClaim(el: HTMLElement | null, claimAll: () => boolean = () => false) {
  const claimAllRef = useRef(claimAll);
  useEffect(() => {
    claimAllRef.current = claimAll;
  });
  useEffect(() => {
    if (!el) return;
    let start: { x: number; y: number } | null = null;
    let decided = false;
    let claimed = false;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      start = t && e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
      decided = false;
      claimed = false;
    };
    const onMove = (e: TouchEvent) => {
      if (claimed) {
        if (e.cancelable) e.preventDefault();
        return;
      }
      const t = e.touches[0];
      if (!start || decided || !t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (dx === 0 && dy === 0) return;
      decided = true;
      if (Math.abs(dx) > Math.abs(dy)) return;
      // 下拉选择框 / 带 data-vaul-no-drag 的区域，vaul 本身就不拖，别替它拦掉原生行为
      if (e.target instanceof Element && e.target.closest("select,[data-vaul-no-drag]")) return;
      const scroller = nearestScroller(e.target, el);
      claimed = claimAllRef.current() || !scroller || (dy > 0 && scroller.scrollTop <= 0);
      if (claimed && e.cancelable) e.preventDefault();
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
    };
  }, [el]);
}

/** 从触点往上找 root 内最近的竖向可滚动容器 */
function nearestScroller(target: EventTarget | null, root: HTMLElement): HTMLElement | null {
  let node = target instanceof Element ? target : null;
  while (node && node !== root) {
    if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight) {
      const oy = getComputedStyle(node).overflowY;
      if (oy === "auto" || oy === "scroll") return node;
    }
    node = node.parentElement;
  }
  return null;
}
