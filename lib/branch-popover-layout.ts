export type PopoverRect = {
  top: number;
  bottom: number;
  left: number;
  right?: number;
  width: number;
  height?: number;
};

export type PopoverPositionInput = {
  selectionRect: PopoverRect;
  expanded: boolean;
  viewport: {
    width: number;
    height: number;
  };
  sidebarWidth?: number;
  rightPanelsWidth?: number;
  topFence?: number;
  isNarrowViewport: boolean;
  pendingAttachmentsCount?: number;
};

export type PopoverPositionStyle = {
  top?: number | string;
  bottom?: number | string;
  left?: number | string;
  right?: number | string;
  width?: number | string;
  maxWidth?: number | string;
  transform?: string;
};

const EXPANDED_DEFAULT_WIDTH = 420;
const COLLAPSED_APPROX_WIDTH = 220;
const GUTTER = 8;
const DEFAULT_TOP_FENCE = 92;

/**
 * 计算划词追问浮窗（BranchPopover）的精确安全定位样式。
 *
 * 核心策略：
 * 1. 移动端/窄屏：吸附在屏幕底部安全区。
 * 2. 桌面端水平方向：
 *    - 读取侧边栏宽度（--trellis-sb）与右侧面板宽度，建立安全区边界 [minLeft, maxRight]；
 *    - 默认水平居中对齐选区中心点；
 *    - 严格做边界 Clamp，保证左边缘不遮挡侧边栏、右边缘不溢出视口。
 * 3. 桌面端垂直方向：
 *    - 优先放在选区上方（top = selection.top - popoverHeight - 8）；
 *    - 当上方空间不足（侵入顶部 Header 区域）且下方空间充足时，智能翻转至选区下方（top = selection.bottom + 8）；
 *    - 空间极度受限时做视口上下限保底 Clamp。
 */
export function computeBranchPopoverPosition(
  input: PopoverPositionInput,
): PopoverPositionStyle {
  const {
    selectionRect,
    expanded,
    viewport,
    sidebarWidth = 0,
    rightPanelsWidth = 0,
    topFence = DEFAULT_TOP_FENCE,
    isNarrowViewport,
    pendingAttachmentsCount = 0,
  } = input;

  if (isNarrowViewport) {
    return {
      right: GUTTER,
      bottom: "calc(var(--safe-bottom) + 8px)",
      left: GUTTER,
      maxWidth: "calc(100vw - 16px)",
    };
  }

  const vw = Math.max(320, viewport.width);
  const vh = Math.max(320, viewport.height);

  // 1. 水平安全区
  const minLeft = sidebarWidth > 0 ? sidebarWidth + GUTTER : GUTTER;
  const maxRight = vw - (rightPanelsWidth > 0 ? rightPanelsWidth + GUTTER : GUTTER);
  const availableWidth = Math.max(160, maxRight - minLeft);

  const targetWidth = expanded
    ? Math.min(EXPANDED_DEFAULT_WIDTH, availableWidth)
    : Math.min(COLLAPSED_APPROX_WIDTH, availableWidth);

  // 选中文本水平中心
  const targetCenter = selectionRect.left + selectionRect.width / 2;

  // 居中计算并 Clamp
  let left = targetCenter - targetWidth / 2;
  left = Math.max(minLeft, Math.min(left, maxRight - targetWidth));

  // 2. 垂直空间与高度估算
  const pendingHeight = pendingAttachmentsCount > 0 ? 96 : 0;
  const popoverHeight = expanded ? 130 + pendingHeight : 38;

  const topIfAbove = selectionRect.top - popoverHeight - GUTTER;
  const topIfBelow = selectionRect.bottom + GUTTER;
  const bottomLimit = vh - popoverHeight - GUTTER;

  let top: number;
  if (topIfAbove >= topFence) {
    // 上方空间充裕
    top = topIfAbove;
  } else if (topIfBelow + popoverHeight <= vh - GUTTER) {
    // 上方放不下但下方放得下 -> 翻转至下方
    top = topIfBelow;
  } else {
    // 上下都受限，保底 clamp 在安全可见区
    top = Math.max(topFence, Math.min(topIfAbove, bottomLimit));
  }

  if (expanded) {
    return {
      top: Math.round(top),
      left: Math.round(left),
      width: Math.round(targetWidth),
      maxWidth: `calc(100vw - ${GUTTER * 2}px)`,
    };
  }

  return {
    top: Math.round(top),
    left: Math.round(left),
    maxWidth: Math.round(availableWidth),
  };
}
