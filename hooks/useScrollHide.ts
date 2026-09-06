"use client";

import {
  useCallback,
  useEffect,
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

  return { isHidden: enabled && isHidden, reveal, updateFromScroll };
}
