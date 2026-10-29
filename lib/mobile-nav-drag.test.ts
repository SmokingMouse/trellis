import { describe, expect, test } from "bun:test";
import { swipeCommit } from "@/lib/gestures";
import {
  DRAWER_SWIPE_THRESHOLD,
  drawerProgress,
  drawerWidth,
  emitNavDrag,
  subscribeNavDrag,
  type NavDragEvent,
} from "@/lib/mobile-nav-drag";

describe("mobile nav drawer drag", () => {
  test("抽屉宽 82vw，封顶 320", () => {
    expect(drawerWidth(390)).toBeCloseTo(319.8);
    expect(drawerWidth(430)).toBe(320);
    expect(drawerWidth(320)).toBeCloseTo(262.4);
  });

  test("遮罩进度随 translateX 线性走，夹在 0..1", () => {
    expect(drawerProgress(-320, 320)).toBe(0);
    expect(drawerProgress(-160, 320)).toBe(0.5);
    expect(drawerProgress(0, 320)).toBe(1);
    expect(drawerProgress(-400, 320)).toBe(0);
    expect(drawerProgress(12, 320)).toBe(1);
    expect(drawerProgress(-10, 0)).toBe(0);
  });

  test("松手判定：>40% 距离或同向甩动成立", () => {
    const size = 320;
    expect(swipeCommit({ delta: 129, velocity: 0, size }, DRAWER_SWIPE_THRESHOLD)).toBe(1);
    expect(swipeCommit({ delta: 127, velocity: 0, size }, DRAWER_SWIPE_THRESHOLD)).toBe(0);
    // 快甩：距离不够但速度够
    expect(swipeCommit({ delta: 40, velocity: 0.8, size }, DRAWER_SWIPE_THRESHOLD)).toBe(1);
    // 往回甩：速度反向不算
    expect(swipeCommit({ delta: 60, velocity: -0.8, size }, DRAWER_SWIPE_THRESHOLD)).toBe(0);
    // 关：向左拖过 40%
    expect(swipeCommit({ delta: -140, velocity: 0, size }, DRAWER_SWIPE_THRESHOLD)).toBe(-1);
    // 轻点抖动不算甩
    expect(swipeCommit({ delta: 10, velocity: 2, size }, DRAWER_SWIPE_THRESHOLD)).toBe(0);
  });

  test("事件总线：订阅 / 退订", () => {
    const got: NavDragEvent[] = [];
    const off = subscribeNavDrag((e) => got.push(e));
    emitNavDrag({ type: "start" });
    emitNavDrag({ type: "move", offset: 42 });
    off();
    emitNavDrag({ type: "end", open: true });
    expect(got).toEqual([{ type: "start" }, { type: "move", offset: 42 }]);
  });
});
