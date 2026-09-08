"use client";
import { useEffect, useState } from "react";

/** Hydrate after mount, so browser preferences never change the SSR markup. */
export function useSidebarPreference<T>(key: string, fallback: T, valid: (value: unknown) => value is T) {
  const [value, setValue] = useState(fallback);
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(`trellis-sidebar-${key}`) ?? "null");
      if (valid(saved)) setValue(saved);
    } catch { /* unavailable storage uses the default */ }
  }, [key, valid]);
  const update = (next: T | ((previous: T) => T)) => setValue(previous => {
    const result = typeof next === "function" ? (next as (previous: T) => T)(previous) : next;
    try { localStorage.setItem(`trellis-sidebar-${key}`, JSON.stringify(result)); } catch { /* session-only */ }
    return result;
  });
  return [value, update] as const;
}

export const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
export const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
