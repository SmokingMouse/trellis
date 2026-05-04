"use client";
import { useEffect, useState } from "react";

// Returns null until first effect runs to avoid SSR/hydration mismatch.
// Consumers should treat null as "not yet known" and render a neutral state.
//
// We detect mobile via `pointer: coarse` (touch primary) rather than viewport
// width — this prevents narrow desktop windows from triggering mobile UX, and
// correctly classifies phones/tablets regardless of orientation.
export function useIsMobile(
  query = "(pointer: coarse) and (max-width: 1023px)",
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
