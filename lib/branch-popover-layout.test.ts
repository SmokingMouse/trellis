import { describe, expect, it } from "bun:test";
import { computeBranchPopoverPosition } from "./branch-popover-layout";

describe("computeBranchPopoverPosition", () => {
  const defaultViewport = { width: 1440, height: 900 };

  it("在窄屏/移动端时固定在屏幕底部", () => {
    const style = computeBranchPopoverPosition({
      selectionRect: { top: 300, bottom: 320, left: 100, width: 80 },
      expanded: false,
      viewport: { width: 375, height: 667 },
      isNarrowViewport: true,
    });

    expect(style.bottom).toBe("calc(var(--safe-bottom) + 8px)");
    expect(style.left).toBe(8);
    expect(style.right).toBe(8);
    expect(style.top).toBeUndefined();
  });

  it("选中文本靠左时，不会遮挡侧边栏（水平 clamp 到 sidebarWidth + 8）", () => {
    // 侧边栏宽 280px，选区中心在 300px
    const style = computeBranchPopoverPosition({
      selectionRect: { top: 400, bottom: 420, left: 285, width: 30 },
      expanded: true,
      viewport: defaultViewport,
      sidebarWidth: 280,
      isNarrowViewport: false,
    });

    // 展开宽度 420，中心在 300，未 clamp 时 left 为 300 - 210 = 90
    // clamp 后 left 必须 >= 280 + 8 = 288
    expect(style.left).toBe(288);
    expect(style.width).toBe(420);
    expect((style.left as number) + (style.width as number)).toBeLessThanOrEqual(
      defaultViewport.width - 8,
    );
  });

  it("选中文本靠右时，不会超出屏幕右侧（水平 clamp 到 maxRight - width）", () => {
    // 视口 1440，选区中心在 1400
    const style = computeBranchPopoverPosition({
      selectionRect: { top: 400, bottom: 420, left: 1380, width: 40 },
      expanded: true,
      viewport: defaultViewport,
      sidebarWidth: 280,
      isNarrowViewport: false,
    });

    // 展开宽度 420，maxRight = 1440 - 8 = 1432
    // left 最大只能是 1432 - 420 = 1012
    expect(style.left).toBe(1012);
    expect(style.width).toBe(420);
  });

  it("选中文本在屏幕居中位置时，正常水平居中对齐选区中心", () => {
    // 选区中心在 720
    const style = computeBranchPopoverPosition({
      selectionRect: { top: 400, bottom: 420, left: 700, width: 40 },
      expanded: true,
      viewport: defaultViewport,
      sidebarWidth: 280,
      isNarrowViewport: false,
    });

    // left = 720 - 210 = 510
    expect(style.left).toBe(510);
    expect(style.width).toBe(420);
  });

  it("选区上方空间充裕时，浮窗呈现在选区上方", () => {
    // top = 500, popoverHeight = 130 -> topIfAbove = 500 - 130 - 8 = 362 >= 92
    const style = computeBranchPopoverPosition({
      selectionRect: { top: 500, bottom: 520, left: 500, width: 50 },
      expanded: true,
      viewport: defaultViewport,
      sidebarWidth: 200,
      isNarrowViewport: false,
      topFence: 92,
    });

    expect(style.top).toBe(362);
  });

  it("选区太靠近顶部时，智能翻转至选区下方", () => {
    // top = 120, popoverHeight = 130 -> topIfAbove = 120 - 130 - 8 = -18 < 92 (topFence)
    // 应该翻转至选区下方: bottom = 140 -> top = 140 + 8 = 148
    const style = computeBranchPopoverPosition({
      selectionRect: { top: 120, bottom: 140, left: 500, width: 50 },
      expanded: true,
      viewport: defaultViewport,
      sidebarWidth: 200,
      isNarrowViewport: false,
      topFence: 92,
    });

    expect(style.top).toBe(148);
  });

  it("有待上传附件时，正确将附加高度计入定位考虑", () => {
    // pendingAttachmentsCount > 0 使得 height 增加 96px (130 + 96 = 226)
    const style = computeBranchPopoverPosition({
      selectionRect: { top: 500, bottom: 520, left: 500, width: 50 },
      expanded: true,
      viewport: defaultViewport,
      sidebarWidth: 200,
      isNarrowViewport: false,
      pendingAttachmentsCount: 2,
    });

    // top = 500 - 226 - 8 = 266
    expect(style.top).toBe(266);
  });
});
