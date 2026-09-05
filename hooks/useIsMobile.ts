"use client";
import { useEffect, useState } from "react";

export const DESKTOP_MODE_OVERRIDE_KEY = "trellis-desktop-mode";
export const MOBILE_VIEWPORT_QUERY = "(max-width: 767.98px)";
export const DESKTOP_VIEWPORT_QUERY = "(min-width: 768px)";

export function desktopModeOverrideEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DESKTOP_MODE_OVERRIDE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setDesktopModeOverride(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (enabled) window.localStorage.setItem(DESKTOP_MODE_OVERRIDE_KEY, "1");
    else window.localStorage.removeItem(DESKTOP_MODE_OVERRIDE_KEY);
  } catch {
    // Storage can be unavailable in private browsing. The caller still
    // reloads; without a durable marker the app safely stays in mobile mode.
  }
}

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
  query = MOBILE_VIEWPORT_QUERY,
): boolean | null {
  const [matches, setMatches] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () =>
      setMatches(desktopModeOverrideEnabled() ? false : mq.matches);
    update();
    mq.addEventListener("change", update);
    window.addEventListener("storage", update);
    return () => {
      mq.removeEventListener("change", update);
      window.removeEventListener("storage", update);
    };
  }, [query]);
  return matches;
}

// Physical viewport queries deliberately ignore the desktop-mode override.
// CSS still follows the real viewport, so layout offsets and narrow-mode
// escape hatches must use these rather than the semantic useIsMobile().
function useViewportMedia(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function useIsNarrowViewport(): boolean {
  return useViewportMedia(MOBILE_VIEWPORT_QUERY);
}

export function useIsDesktopViewport(): boolean {
  return useViewportMedia(DESKTOP_VIEWPORT_QUERY);
}
