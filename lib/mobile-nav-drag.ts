// 手机侧栏抽屉的跟手拖拽：左缘右滑（components/MobileEdgeSwipe，document 级 touch）
// 与抽屉本体（components/MobileNavDrawer）是两个组件，这里是它们之间的一条极小事件总线 ——
// 跟手位移每帧一发，走订阅直接改 DOM 样式，不进 React state / zustand（否则每帧重渲整个侧栏）。
// 判定与几何是纯函数，单测见 lib/mobile-nav-drag.test.ts。

import type { SwipeThreshold } from "@/lib/gestures";

/** 抽屉宽度：82vw，封顶 320px（与 SessionSidebar 抽屉的 w-[82vw] max-w-[320px] 一致）。 */
export const DRAWER_MAX_WIDTH = 320;
export function drawerWidth(viewportWidth: number): number {
  return Math.min(DRAWER_MAX_WIDTH, viewportWidth * 0.82);
}

/**
 * 抽屉开 / 关的松手判定：拖过抽屉宽度 40% 直接成立；不够远但甩得够快（且方向一致）也成立。
 * 没有 px 下限 —— 抽屉本身就是那把尺子。
 */
export const DRAWER_SWIPE_THRESHOLD: SwipeThreshold = {
  ratio: 0.4,
  minDistance: 0,
  velocity: 0.5,
  minFlingDistance: 24,
};

/** 遮罩透明度跟位移走：x 是抽屉 translateX（-width = 全收起，0 = 全展开）。 */
export function drawerProgress(x: number, width: number): number {
  if (width <= 0) return 0;
  return Math.max(0, Math.min(1, 1 + x / width));
}

export type NavDragEvent =
  | { type: "start" }
  /** offset：手指相对起点向右走了多少 px（已夹在 0..width） */
  | { type: "move"; offset: number }
  /** open：松手判定结果；true = 落到展开，false = 弹回收起 */
  | { type: "end"; open: boolean }
  | { type: "cancel" };

const listeners = new Set<(e: NavDragEvent) => void>();

export function emitNavDrag(e: NavDragEvent): void {
  listeners.forEach((fn) => fn(e));
}

export function subscribeNavDrag(fn: (e: NavDragEvent) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
