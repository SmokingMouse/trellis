"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

// P1: flips true once `ref`'s element comes within `margin` px of the scroll
// viewport, so long threads can mount cheap plain-text placeholders and
// upgrade cards to full markdown only as the user approaches. `force` skips
// the wait for cards that must render immediately (e.g. a pending
// scroll-anchor target — the flash effect inside useMarkdownBodyMarks needs
// the markdown DOM to scroll to).
//
// Also compensates the scroll container for the placeholder→real height
// delta: when a card above the viewport grows during upgrade, everything the
// user sees would otherwise jump down by the same amount. The placeholder
// height is captured at flip time (DOM still placeholder — setState flushes
// later) and diffed in a layout effect before paint. Effects run in document
// order, so by the time a card's effect reads its own top, every card above
// it has already compensated — the position check then reduces to "was this
// card originally above the fold", which is exactly the compensation rule.
//
// The scroll container is found via [data-thread-scroll] — mark the thread's
// scroll root with it (LinearThreadView).
export function useNearViewport(
  ref: React.RefObject<HTMLElement | null>,
  opts: { margin?: number; force?: boolean } = {},
) {
  const { margin = 800, force = false } = opts;
  const [near, setNear] = useState(false);
  const placeholderH = useRef(0);

  useEffect(() => {
    if (near || force) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          placeholderH.current = el.offsetHeight;
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: `${margin}px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near, force, margin, ref]);

  useLayoutEffect(() => {
    if (!near) return;
    const el = ref.current;
    if (!el || !placeholderH.current) return;
    const delta = el.offsetHeight - placeholderH.current;
    placeholderH.current = 0;
    if (!delta) return;
    const container = el.closest<HTMLElement>("[data-thread-scroll]");
    if (!container) return;
    // Only growth at/above the viewport's visible top shifts what the user
    // sees; cards below the fold can grow freely.
    if (el.getBoundingClientRect().top >= container.getBoundingClientRect().top)
      return;
    container.scrollTop += delta;
  }, [near, ref]);

  return near || force;
}
