"use client";

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";

// H-3: this used to be module-level (one `hidden` + one `listeners` Set for
// the whole app). That accidentally made every mounted thread view share one
// hide/reveal flag — harmless while exactly one is ever mounted, but a latent
// trap for any future multi-mount (split view, a second linear thread in a
// portal, tests rendering two trees). The store is now created per Provider
// instance instead, so each mounted tree gets its own.
export type ScrollHideStore = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => boolean;
  setHidden: (next: boolean) => void;
};

export function createScrollHideStore(): ScrollHideStore {
  const listeners = new Set<() => void>();
  let hidden = false;
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return hidden;
    },
    setHidden(next) {
      if (hidden === next) return;
      hidden = next;
      listeners.forEach((listener) => listener());
    },
  };
}

// C2-3: pulled out of the layout effect so the clamp-at-bottom arithmetic can
// be unit-tested directly. LinearThreadView's own "near the bottom" follow
// logic (FOLLOW_SLACK_PX=120, bigger than the ~104px chrome shift ever
// measured) happens to keep this branch's overflow case unreachable through
// real scrolling today — but the hook can't assume every future caller keeps
// that margin, so it still has to hold up on its own.
export function computeRevealScroll({
  scrollTop,
  chromeShift,
  scrollHeight,
  clientHeight,
}: {
  scrollTop: number;
  chromeShift: number;
  scrollHeight: number;
  clientHeight: number;
}): { scrollTop: number; paddingBottom: number } {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  const desired = scrollTop + chromeShift;
  const overflow = Math.max(0, desired - maxScrollTop);
  return { scrollTop: desired, paddingBottom: overflow };
}

const ScrollHideContext = createContext<ScrollHideStore | null>(null);

export function ScrollHideProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<ScrollHideStore | null>(null);
  if (!storeRef.current) storeRef.current = createScrollHideStore();
  return createElement(
    ScrollHideContext.Provider,
    { value: storeRef.current },
    children,
  );
}

function useScrollHideStore(): ScrollHideStore {
  const store = useContext(ScrollHideContext);
  if (!store) {
    throw new Error(
      "useScrollHide/useScrollHideState must be used within a ScrollHideProvider",
    );
  }
  return store;
}

export function useScrollHideState() {
  const store = useScrollHideStore();
  const isHidden = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    () => false,
  );
  const reveal = useCallback(() => store.setHidden(false), [store]);
  return { isHidden, reveal };
}

export function useScrollHide({
  enabled,
  resetKey,
  scrollRef,
  readyDelayMs = 400,
}: {
  enabled: boolean;
  resetKey?: string | null;
  scrollRef: RefObject<HTMLElement | null>;
  readyDelayMs?: number;
}) {
  const store = useScrollHideStore();
  const { isHidden, reveal } = useScrollHideState();
  const lastScrollTopRef = useRef(0);
  const readyRef = useRef(false);
  const previousHiddenRef = useRef(false);
  const chromeShiftRef = useRef(0);
  // C2-3: how much of the last reveal's compensation got clamped away
  // because the container had no more scroll range to give (already at the
  // bottom). Kept so the container can lend that space back via padding
  // instead of eating a residual jump.
  const bottomPadRef = useRef(0);
  const effectiveHidden = enabled && isHidden;

  // The scroll viewport moves upward when both mobile chrome rows hide. Move
  // scrollTop by the inverse amount in a layout effect so the same reading
  // anchor remains at the same screen coordinate before the next paint.
  useLayoutEffect(() => {
    if (previousHiddenRef.current === effectiveHidden) return;
    const el = scrollRef.current;
    if (el) {
      if (effectiveHidden) {
        if (bottomPadRef.current) {
          bottomPadRef.current = 0;
          el.style.paddingBottom = "";
        }
        const rootStyle = getComputedStyle(document.documentElement);
        const safeTop =
          Number.parseFloat(rootStyle.getPropertyValue("--safe-top")) || 0;
        const mobileHeaderHeight =
          document
            .querySelector<HTMLElement>("[data-mobile-header]")
            ?.getBoundingClientRect().height ?? 0;
        const threadHeaderHeight =
          document
            .querySelector<HTMLElement>("[data-thread-header]")
            ?.getBoundingClientRect().height ?? 0;
        chromeShiftRef.current = Math.max(
          0,
          mobileHeaderHeight + threadHeaderHeight - safeTop,
        );
        el.scrollTop = Math.max(0, el.scrollTop - chromeShiftRef.current);
      } else {
        // Already scrolled (at or near) to the bottom: there isn't enough
        // native scroll range left to absorb the full reveal shift. Lend
        // the container that much extra bottom padding so scrollTop can
        // actually reach `desired` instead of being clamped and leaving a
        // residual on-screen jump. Reset above the next time chrome hides.
        const { scrollTop, paddingBottom } = computeRevealScroll({
          scrollTop: el.scrollTop,
          chromeShift: chromeShiftRef.current,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        });
        if (paddingBottom !== bottomPadRef.current) {
          bottomPadRef.current = paddingBottom;
          el.style.paddingBottom = paddingBottom > 0 ? `${paddingBottom}px` : "";
        }
        el.scrollTop = scrollTop;
      }
      lastScrollTopRef.current = el.scrollTop;
    }
    previousHiddenRef.current = effectiveHidden;
  }, [effectiveHidden, scrollRef]);

  useEffect(() => {
    store.setHidden(false);
    lastScrollTopRef.current = 0;
    readyRef.current = false;
    bottomPadRef.current = 0;
    if (scrollRef.current) scrollRef.current.style.paddingBottom = "";
    if (!enabled) return;

    const timer = window.setTimeout(() => {
      lastScrollTopRef.current = scrollRef.current?.scrollTop ?? 0;
      readyRef.current = true;
    }, readyDelayMs);
    return () => {
      window.clearTimeout(timer);
      store.setHidden(false);
    };
  }, [enabled, readyDelayMs, resetKey, scrollRef, store]);

  const updateFromScroll = useCallback(
    (scrollTop: number, forceVisible = false) => {
      const delta = scrollTop - lastScrollTopRef.current;
      lastScrollTopRef.current = scrollTop;
      if (!enabled || !readyRef.current) return;

      if (forceVisible || scrollTop <= 0 || delta < -8) {
        store.setHidden(false);
      } else if (delta > 8) {
        store.setHidden(true);
      }
    },
    [enabled, store],
  );

  return { isHidden: effectiveHidden, reveal, updateFromScroll };
}
