import { describe, expect, test } from "bun:test";
import { computeKeyboardInset, KEYBOARD_CLOSED } from "./useKeyboardInset";

describe("computeKeyboardInset", () => {
  test("无键盘：视口等高即关闭", () => {
    expect(
      computeKeyboardInset({ innerHeight: 844, viewportHeight: 844, offsetTop: 0 }),
    ).toEqual(KEYBOARD_CLOSED);
  });

  test("工具栏收展的小幅抖动不算键盘", () => {
    expect(
      computeKeyboardInset({ innerHeight: 844, viewportHeight: 790, offsetTop: 0 }),
    ).toEqual(KEYBOARD_CLOSED);
  });

  test("键盘弹起、未平移：底部让出键盘高度", () => {
    expect(
      computeKeyboardInset({ innerHeight: 844, viewportHeight: 508, offsetTop: 0 }),
    ).toEqual({ top: 0, bottom: 336, open: true });
  });

  test("iOS 平移视口：top 跟随平移，bottom 扣掉平移量", () => {
    expect(
      computeKeyboardInset({ innerHeight: 844, viewportHeight: 508, offsetTop: 200 }),
    ).toEqual({ top: 200, bottom: 136, open: true });
  });

  test("回弹时 offsetTop 为负或超界也不出负数", () => {
    expect(
      computeKeyboardInset({ innerHeight: 844, viewportHeight: 508, offsetTop: -10.4 }),
    ).toEqual({ top: 0, bottom: 346, open: true });
  });
});
