"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type RefObject,
} from "react";

const listeners = new Set<() => void>();
let hidden = false;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return hidden;
}

function setHidden(next: boolean) {
  if (hidden === next) return;
  hidden = next;
  listeners.forEach((listener) => listener());
}

export function useScrollHideState() {
  const isHidden = useSyncExternalStore(subscribe, getSnapshot, () => false);
  const reveal = useCallback(() => setHidden(false), []);
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
  const { isHidden, reveal } = useScrollHideState();
  const lastScrollTopRef = useRef(0);
  const readyRef = useRef(false);
  const previousHiddenRef = useRef(false);
  const chromeShiftRef = useRef(0);
  const effectiveHidden = enabled && isHidden;

  // The scroll viewport moves upward when both mobile chrome rows hide. Move
  // scrollTop by the inverse amount in a layout effect so the same reading
  // anchor remains at the same screen coordinate before the next paint.
  useLayoutEffect(() => {
    if (previousHiddenRef.current === effectiveHidden) return;
    const el = scrollRef.current;
    if (el) {
      if (effectiveHidden) {
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
        const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
        el.scrollTop = Math.min(
          maxScrollTop,
          el.scrollTop + chromeShiftRef.current,
        );
      }
      lastScrollTopRef.current = el.scrollTop;
    }
    previousHiddenRef.current = effectiveHidden;
  }, [effectiveHidden, scrollRef]);

  useEffect(() => {
    setHidden(false);
    lastScrollTopRef.current = 0;
    readyRef.current = false;
    if (!enabled) return;

    const timer = window.setTimeout(() => {
      lastScrollTopRef.current = scrollRef.current?.scrollTop ?? 0;
      readyRef.current = true;
    }, readyDelayMs);
    return () => {
      window.clearTimeout(timer);
      setHidden(false);
    };
  }, [enabled, readyDelayMs, resetKey, scrollRef]);

  const updateFromScroll = useCallback(
    (scrollTop: number, forceVisible = false) => {
      const delta = scrollTop - lastScrollTopRef.current;
      lastScrollTopRef.current = scrollTop;
      if (!enabled || !readyRef.current) return;

      if (forceVisible || scrollTop <= 0 || delta < -8) {
        setHidden(false);
      } else if (delta > 8) {
        setHidden(true);
      }
    },
    [enabled],
  );

  return { isHidden: effectiveHidden, reveal, updateFromScroll };
}
