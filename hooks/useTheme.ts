"use client";
import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";
const STORAGE_KEY = "trellis-theme";

// Reads + writes the same localStorage key the pre-hydration script in
// layout.tsx uses. Returns null until first effect runs (consumers that
// render light/dark icons should treat null as "not yet known" to avoid
// hydration mismatches — though the inline script means the html.dark
// class is correct from t=0).
export function useTheme(): {
  theme: Theme | null;
  toggle: () => void;
  setTheme: (t: Theme) => void;
} {
  const [theme, setThemeState] = useState<Theme | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const initial: Theme = document.documentElement.classList.contains("dark")
      ? "dark"
      : "light";
    setThemeState(initial);

    // Track OS-level changes so users who haven't picked a manual
    // preference (no localStorage entry) follow their system's
    // light/dark schedule.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => {
      if (window.localStorage.getItem(STORAGE_KEY)) return;
      const next: Theme = e.matches ? "dark" : "light";
      apply(next);
      setThemeState(next);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    apply(t);
    setThemeState(t);
    try {
      window.localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* private mode etc — keep going */
    }
  }, []);

  const toggle = useCallback(() => {
    setTheme(
      (document.documentElement.classList.contains("dark") ? "light" : "dark"),
    );
  }, [setTheme]);

  return { theme, toggle, setTheme };
}

function apply(t: Theme) {
  if (typeof document === "undefined") return;
  if (t === "dark") document.documentElement.classList.add("dark");
  else document.documentElement.classList.remove("dark");
}
