import { describe, expect, test } from "bun:test";
import {
  AUTO_FONT_FLOOR,
  NO_MODIFIERS,
  RECONNECT_DELAYS_S,
  applyModifiers,
  autoFontSize,
  fitFontSize,
  isSingleKey,
  namedKeyFor,
  reconnectDelayMs,
  swipeLines,
} from "./herdr-term-keys";

const ctrl = { ...NO_MODIFIERS, ctrl: true };
const alt = { ...NO_MODIFIERS, alt: true };
const shift = { ...NO_MODIFIERS, shift: true };

describe("粘滞修饰键", () => {
  test("Ctrl + 字母 / 符号 → C0 控制字符", () => {
    expect(applyModifiers("c", ctrl)).toBe("\x03");
    expect(applyModifiers("C", ctrl)).toBe("\x03");
    expect(applyModifiers("[", ctrl)).toBe("\x1b");
    expect(applyModifiers(" ", ctrl)).toBe("\x00");
    expect(applyModifiers("?", ctrl)).toBe("\x7f");
    expect(applyModifiers("1", ctrl)).toBe("1");
  });

  test("Alt = 前缀 ESC；Shift 大写", () => {
    expect(applyModifiers("x", alt)).toBe("\x1bx");
    expect(applyModifiers("x", shift)).toBe("X");
    expect(applyModifiers("x", { ctrl: true, alt: true, shift: false })).toBe("\x1b\x18");
  });

  test("方向键带修饰参数（两种光标模式都认）", () => {
    expect(applyModifiers("\x1b[A", ctrl)).toBe("\x1b[1;5A");
    expect(applyModifiers("\x1bOD", shift)).toBe("\x1b[1;2D");
    expect(applyModifiers("\x1b[C", { ctrl: true, alt: true, shift: true })).toBe("\x1b[1;8C");
  });

  test("Tab / 退格", () => {
    expect(applyModifiers("\t", shift)).toBe("\x1b[Z");
    expect(applyModifiers("\x7f", ctrl)).toBe("\x08");
    expect(applyModifiers("\x7f", alt)).toBe("\x1b\x7f");
  });

  test("不是一个键（输入法上屏、多字符）原样返回、不消耗修饰", () => {
    expect(isSingleKey("你好")).toBe(false);
    expect(isSingleKey("中")).toBe(true);
    expect(isSingleKey("😀")).toBe(true);
    expect(applyModifiers("你好", ctrl)).toBe("你好");
    expect(applyModifiers("abc", NO_MODIFIERS)).toBe("abc");
  });

  test("⇧ + 回车走具名键 shift+enter，其它组合不走", () => {
    expect(namedKeyFor("\r", shift)).toBe("shift+enter");
    expect(namedKeyFor("\r", { ...shift, ctrl: true })).toBeNull();
    expect(namedKeyFor("\r", NO_MODIFIERS)).toBeNull();
    expect(namedKeyFor("a", shift)).toBeNull();
  });
});

describe("字号适配", () => {
  // 等宽字体近似：宽 0.6em，高 1.25em。
  const measure = (fs: number) => ({ width: fs * 0.6, height: fs * 1.25 });

  test("整屏塞得下取最大字号", () => {
    const fs = fitFontSize({ width: 600, height: 400 }, { cols: 80, rows: 24 }, measure, { max: 14 });
    expect(fs).not.toBeNull();
    expect(fs! * 0.6 * 80).toBeLessThanOrEqual(600);
    expect(fs! * 1.25 * 24).toBeLessThanOrEqual(400);
    expect((fs! + 0.25) * 0.6 * 80 > 600 || (fs! + 0.25) * 1.25 * 24 > 400).toBe(true);
  });

  test("自动三档：整屏 → 只按宽度 → 下限字号平移", () => {
    expect(autoFontSize({ width: 800, height: 600 }, { cols: 80, rows: 24 }, measure).tier).toBe("complete");
    // 很高的窗格：按宽度能读，按整屏就太小。
    expect(autoFontSize({ width: 800, height: 300 }, { cols: 80, rows: 200 }, measure).tier).toBe("width");
    // 手机竖屏看 213 列：只能平移。
    const pan = autoFontSize({ width: 360, height: 600 }, { cols: 213, rows: 55 }, measure);
    expect(pan).toEqual({ fontSize: AUTO_FONT_FLOOR, tier: "pan" });
  });
});

describe("重连与手势", () => {
  test("退避序列带 ±20% 抖动，封顶在最后一档", () => {
    expect(reconnectDelayMs(0, () => 0.5)).toBe(1000);
    expect(reconnectDelayMs(0, () => 0)).toBe(800);
    expect(reconnectDelayMs(0, () => 1)).toBe(1200);
    expect(reconnectDelayMs(99, () => 0.5)).toBe(RECONNECT_DELAYS_S.at(-1)! * 1000);
  });

  test("滑动像素换算行数", () => {
    expect(swipeLines(50, 16)).toBe(3);
    expect(swipeLines(-50, 16)).toBe(-3);
    expect(swipeLines(10, 0)).toBe(0);
  });
});
