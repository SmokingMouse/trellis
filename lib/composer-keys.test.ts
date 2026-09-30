import { describe, expect, test } from "bun:test";
import { resolveComposerKey } from "./composer-keys";

const key = (k: string, mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing: boolean; keyCode: number }> = {}) => ({
  key: k,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  ...mods,
});
const opts = (over: Partial<Parameters<typeof resolveComposerKey>[1]> = {}) => ({
  sendKey: "mod-enter" as const,
  compositionEndAt: 0,
  now: 10_000,
  handlesEscape: false,
  ...over,
});

describe("resolveComposerKey（常规与 Herdr 输入框共用）", () => {
  test("默认 ⌘↩ / Ctrl↩ 发送，↩ 与 ⇧↩ 换行", () => {
    expect(resolveComposerKey(key("Enter", { metaKey: true }), opts())).toBe("send");
    expect(resolveComposerKey(key("Enter", { ctrlKey: true }), opts())).toBe("send");
    expect(resolveComposerKey(key("Enter"), opts())).toBe("default");
    expect(resolveComposerKey(key("Enter", { shiftKey: true }), opts())).toBe("default");
  });

  test("偏好 ↩ 发送时：↩ 发送、⇧↩ 换行", () => {
    expect(resolveComposerKey(key("Enter"), opts({ sendKey: "enter" }))).toBe("send");
    expect(resolveComposerKey(key("Enter", { shiftKey: true }), opts({ sendKey: "enter" }))).toBe("default");
  });

  test("输入法组字中、以及 compositionend 后 100ms 内的 Enter 不发送", () => {
    expect(resolveComposerKey(key("Enter", { metaKey: true, isComposing: true }), opts())).toBe("ignore");
    expect(resolveComposerKey(key("Enter", { metaKey: true, keyCode: 229 }), opts())).toBe("ignore");
    expect(resolveComposerKey(key("Enter", { metaKey: true }), opts({ compositionEndAt: 9_950 }))).toBe("ignore");
    expect(resolveComposerKey(key("Enter", { metaKey: true }), opts({ compositionEndAt: 9_800 }))).toBe("send");
  });

  test("Esc 只在调用方处理时才拦", () => {
    expect(resolveComposerKey(key("Escape"), opts())).toBe("default");
    expect(resolveComposerKey(key("Escape"), opts({ handlesEscape: true }))).toBe("escape");
  });
});
