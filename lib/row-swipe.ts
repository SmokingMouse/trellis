// 列表行左右滑动（侧栏会话行，参考 iOS 邮件 / Codex）的纯判定层，单测见 lib/row-swipe.test.ts。
// 方向锁定、跟手、松手判定的 DOM 部分在 hooks/useSwipe.ts + components/SwipeableRow.tsx。
//
// 约定：offset 右为正。
//   leading  = 右滑从左侧露出的动作（offset > 0）
//   trailing = 左滑从右侧露出的动作（offset < 0）
// 松手结果：
//   close            回弹
//   open-leading     停在露出 leading 按钮的位置（按钮可点）
//   open-trailing    停在露出 trailing 按钮的位置
//   commit-leading   滑过「整行阈值」→ 直接执行 leading 的主动作
//   commit-trailing  同上，trailing 主动作

import { rubberBand } from "@/lib/gestures";

export type RowSwipeSide = "leading" | "trailing";
export type RowSwipeResult = "close" | "open-leading" | "open-trailing" | "commit-leading" | "commit-trailing";

/** 每个露出按钮的宽度：≥44px 触控热区，给不熟悉手势、只想点的人。 */
export const ROW_ACTION_WIDTH = 72;
/** 整行阈值：至少露出按钮再多划这么远，才算「划到底」。 */
export const ROW_FULL_EXTRA = 56;
/** 整行阈值占行宽的比例下限。 */
export const ROW_FULL_RATIO = 0.6;
/** 甩动判定（px/ms）：距离不够半个按钮区，但朝外甩也展开；朝回甩直接收起。 */
export const ROW_FLING_VELOCITY = 0.4;

export type RowSwipeConfig = {
  /** leading 露出区宽度（0 = 这一侧没有动作） */
  leadingWidth: number;
  trailingWidth: number;
  /** leading 侧是否支持划到底直接执行 */
  leadingFull: boolean;
  trailingFull: boolean;
};

/** 划到底的距离阈值（取绝对值比较）。 */
export function fullSwipeDistance(width: number, revealWidth: number): number {
  return Math.max(width * ROW_FULL_RATIO, revealWidth + ROW_FULL_EXTRA);
}

/** 已展开时的静止位移。 */
export function restOffset(side: RowSwipeSide | null, cfg: RowSwipeConfig): number {
  if (side === "leading") return cfg.leadingWidth;
  if (side === "trailing") return -cfg.trailingWidth;
  return 0;
}

/**
 * 跟手位移：base（展开态的静止位移）+ 手指位移。
 * 没有动作的一侧走阻尼（拉得动但很沉、松手回弹）；有动作的一侧：
 * 支持划到底 → 最多到整行宽；不支持 → 露出区之外走阻尼。
 */
export function dragOffset(base: number, delta: number, width: number, cfg: RowSwipeConfig): number {
  const raw = base + delta;
  if (raw === 0) return 0;
  const side: RowSwipeSide = raw > 0 ? "leading" : "trailing";
  const reveal = side === "leading" ? cfg.leadingWidth : cfg.trailingWidth;
  const full = side === "leading" ? cfg.leadingFull : cfg.trailingFull;
  const sign = raw > 0 ? 1 : -1;
  const abs = Math.abs(raw);
  if (reveal <= 0) return rubberBand(raw, 24);
  if (full) return sign * Math.min(abs, width);
  if (abs <= reveal) return raw;
  return sign * reveal + rubberBand(raw - sign * reveal, 24);
}

/** 当前位移是否已过「划到底」阈值（跟手时用来把主按钮拉满、文案改成「松手…」）。 */
export function isFullArmed(offset: number, width: number, cfg: RowSwipeConfig): boolean {
  if (offset > 0) return cfg.leadingFull && cfg.leadingWidth > 0 && offset >= fullSwipeDistance(width, cfg.leadingWidth);
  if (offset < 0) return cfg.trailingFull && cfg.trailingWidth > 0 && -offset >= fullSwipeDistance(width, cfg.trailingWidth);
  return false;
}

/**
 * 松手判定。offset = 松手瞬间的跟手位移，velocity = 沿 x 的速度（px/ms，右正）。
 *   过整行阈值 → commit；
 *   朝回甩（与 offset 反向且够快）→ close；
 *   露出过半个按钮区，或朝外甩 → open；
 *   其余回弹。
 */
export function resolveRowSwipe(input: {
  offset: number;
  velocity: number;
  width: number;
  cfg: RowSwipeConfig;
}): RowSwipeResult {
  const { offset, velocity, width, cfg } = input;
  if (offset === 0) return "close";
  const side: RowSwipeSide = offset > 0 ? "leading" : "trailing";
  const reveal = side === "leading" ? cfg.leadingWidth : cfg.trailingWidth;
  if (reveal <= 0) return "close";
  if (isFullArmed(offset, width, cfg)) return side === "leading" ? "commit-leading" : "commit-trailing";
  const sign = offset > 0 ? 1 : -1;
  const abs = Math.abs(offset);
  if (Math.sign(velocity) === -sign && Math.abs(velocity) >= ROW_FLING_VELOCITY) return "close";
  const flingOut = Math.sign(velocity) === sign && Math.abs(velocity) >= ROW_FLING_VELOCITY && abs >= 24;
  if (abs >= reveal / 2 || flingOut) return side === "leading" ? "open-leading" : "open-trailing";
  return "close";
}
