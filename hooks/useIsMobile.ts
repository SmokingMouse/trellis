"use client";
import { useEffect, useState } from "react";

// Returns null until first effect runs to avoid SSR/hydration mismatch.
// Consumers should treat null as "not yet known" and render a neutral state.
//
// 布局断点只看宽度，且与 Tailwind `md:`(768px) 完全同一条线——此前 JS 用
// `(pointer:coarse) and (max-width:1023px)`、CSS 用 md:，两套判定在
// 「窄窗口 fine-pointer」（sb offset 不归零、内容被挤右）与「768-1023
// coarse 平板」（桌面 rail 叠内容 + hamburger 消失）两个区间确定性错位
// （W0 截图实锤）。宽度之外的能力差异（触控手势等）如需判定，另用
// `(pointer: coarse)` 单独查询，不再混进布局断点。
export function useIsMobile(
  query = "(max-width: 767px)",
): boolean | null {
  const [matches, setMatches] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return matches;
}
