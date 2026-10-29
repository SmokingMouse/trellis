"use client";

import { useEffect, useState } from "react";

// 手机软键盘适配。iOS Safari 弹键盘时 layout viewport 不缩、只缩 visual
// viewport，还会把视口往下平移去「露出」输入框——`fixed inset-0` 的会话列
// 底部那条输入框于是被键盘盖住，或者整页跟着滚走。这里读 visualViewport，把
// 会话列钉在「键盘之上的可见区域」：top 跟随平移量，bottom 让出键盘高度。
// Android Chrome 走 viewport meta 的 interactiveWidget=resizes-content，
// layout viewport 自己会缩，算出来的 inset 恒为 0，不会双重扣减。

export type KeyboardInset = {
  /** 可见区域相对 layout viewport 顶部的平移（px）。 */
  top: number;
  /** 可见区域下沿到 layout viewport 底部的距离，即键盘占掉的高度（px）。 */
  bottom: number;
  /** 键盘是否弹起：弹起时底部安全区由键盘覆盖，不再额外留白。 */
  open: boolean;
};

export const KEYBOARD_CLOSED: KeyboardInset = { top: 0, bottom: 0, open: false };

// 低于这个高度的视口差不算键盘：iOS 工具栏收展、地址栏动画都会产生几十 px 的
// 抖动，把它们当键盘会让输入框上下乱跳。
export const KEYBOARD_MIN_PX = 120;

export function computeKeyboardInset({
  innerHeight,
  viewportHeight,
  offsetTop,
}: {
  innerHeight: number;
  viewportHeight: number;
  offsetTop: number;
}): KeyboardInset {
  const top = Math.max(0, Math.round(offsetTop));
  const bottom = Math.max(0, Math.round(innerHeight - viewportHeight - offsetTop));
  if (innerHeight - viewportHeight < KEYBOARD_MIN_PX) return KEYBOARD_CLOSED;
  return { top, bottom, open: true };
}

function sameInset(a: KeyboardInset, b: KeyboardInset) {
  return a.top === b.top && a.bottom === b.bottom && a.open === b.open;
}

export function useKeyboardInset(enabled: boolean): KeyboardInset {
  const [inset, setInset] = useState<KeyboardInset>(KEYBOARD_CLOSED);

  useEffect(() => {
    const vv = typeof window === "undefined" ? null : window.visualViewport;
    if (!enabled || !vv) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const next = computeKeyboardInset({
        innerHeight: window.innerHeight,
        viewportHeight: vv.height,
        offsetTop: vv.offsetTop,
      });
      setInset((prev) => (sameInset(prev, next) ? prev : next));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
    };
  }, [enabled]);

  // 关闭时不在 effect 里复位 state，直接按开关派生，避免多一轮渲染。
  return enabled ? inset : KEYBOARD_CLOSED;
}
