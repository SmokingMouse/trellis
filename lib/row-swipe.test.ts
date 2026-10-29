import { describe, expect, test } from "bun:test";
import {
  ROW_ACTION_WIDTH,
  dragOffset,
  fullSwipeDistance,
  isFullArmed,
  resolveRowSwipe,
  restOffset,
  type RowSwipeConfig,
} from "./row-swipe";

const W = 300;
// 侧栏会话行：右滑一个「置顶」，左滑「删除 + 归档」，两侧都支持划到底
const cfg: RowSwipeConfig = {
  leadingWidth: ROW_ACTION_WIDTH,
  trailingWidth: ROW_ACTION_WIDTH * 2,
  leadingFull: true,
  trailingFull: true,
};

describe("restOffset / fullSwipeDistance", () => {
  test("展开态的静止位移", () => {
    expect(restOffset(null, cfg)).toBe(0);
    expect(restOffset("leading", cfg)).toBe(72);
    expect(restOffset("trailing", cfg)).toBe(-144);
  });
  test("整行阈值取「行宽比例」与「露出区 + 余量」的大者", () => {
    expect(fullSwipeDistance(300, 72)).toBe(180);
    expect(fullSwipeDistance(300, 144)).toBe(200);
    expect(fullSwipeDistance(200, 144)).toBe(200);
  });
});

describe("dragOffset 跟手", () => {
  test("有动作且支持划到底：跟手，最多一整行", () => {
    expect(dragOffset(0, -50, W, cfg)).toBe(-50);
    expect(dragOffset(0, -400, W, cfg)).toBe(-300);
    expect(dragOffset(-144, -30, W, cfg)).toBe(-174);
  });
  test("没有动作的一侧走阻尼", () => {
    const noLeading = { ...cfg, leadingWidth: 0 };
    const d = dragOffset(0, 200, W, noLeading);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(24);
  });
  test("不支持划到底：露出区之外阻尼", () => {
    const noFull = { ...cfg, trailingFull: false };
    const d = dragOffset(0, -300, W, noFull);
    expect(d).toBeLessThan(-144);
    expect(d).toBeGreaterThan(-144 - 24);
  });
  test("从展开态往回划穿过 0 到另一侧", () => {
    expect(dragOffset(-144, 144, W, cfg)).toBe(0);
    expect(dragOffset(-144, 184, W, cfg)).toBe(40);
  });
});

describe("resolveRowSwipe 松手", () => {
  test("位移 0 或没动作的一侧 → 回弹", () => {
    expect(resolveRowSwipe({ offset: 0, velocity: 0, width: W, cfg })).toBe("close");
    expect(resolveRowSwipe({ offset: 60, velocity: 0, width: W, cfg: { ...cfg, leadingWidth: 0 } })).toBe("close");
  });
  test("过半个露出区 → 展开", () => {
    expect(resolveRowSwipe({ offset: -80, velocity: 0, width: W, cfg })).toBe("open-trailing");
    expect(resolveRowSwipe({ offset: 40, velocity: 0, width: W, cfg })).toBe("open-leading");
  });
  test("不足半个 → 回弹；但朝外甩也展开", () => {
    expect(resolveRowSwipe({ offset: -40, velocity: 0, width: W, cfg })).toBe("close");
    expect(resolveRowSwipe({ offset: -40, velocity: -0.8, width: W, cfg })).toBe("open-trailing");
    // 太短的甩不算（轻点带出的抖动）
    expect(resolveRowSwipe({ offset: -10, velocity: -0.8, width: W, cfg })).toBe("close");
  });
  test("朝回甩 → 收起，即使露出够多", () => {
    expect(resolveRowSwipe({ offset: -130, velocity: 0.8, width: W, cfg })).toBe("close");
  });
  test("划到底 → 直接执行主动作；速度快也不会把短划误判成执行", () => {
    expect(resolveRowSwipe({ offset: -200, velocity: 0, width: W, cfg })).toBe("commit-trailing");
    expect(resolveRowSwipe({ offset: 180, velocity: 0, width: W, cfg })).toBe("commit-leading");
    expect(resolveRowSwipe({ offset: -150, velocity: -3, width: W, cfg })).toBe("open-trailing");
  });
  test("不支持划到底的一侧只会展开", () => {
    const noFull = { ...cfg, trailingFull: false };
    expect(resolveRowSwipe({ offset: -290, velocity: 0, width: W, cfg: noFull })).toBe("open-trailing");
    expect(isFullArmed(-290, W, noFull)).toBe(false);
  });
});
