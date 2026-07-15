"use client";
import { useEffect, useState } from "react";

// Shared keyboard navigation for the "/" suggestion dropdowns (commands +
// skills): ↑↓ moves the highlight (wraps), Enter/Tab picks it. The list is
// derived from the input text, so the highlight resets to the top whenever
// the query changes; arrow keys alone don't touch the text and keep it.
//
// handleKeyDown returns true when it consumed the event — callers check it
// BEFORE their send-combo handling, so Enter picks the highlighted item
// instead of sending a partial "/cle" to the LLM while suggestions are
// visible. With no suggestions it returns false and typing/sending is
// untouched.
export function useSlashNav(
  itemCount: number,
  query: string,
  onPick: (index: number) => void,
) {
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [query]);
  // The list can shrink while the highlight sits past its end (filter
  // narrowed) — clamp instead of flashing an out-of-range highlight.
  const active = itemCount > 0 ? Math.min(index, itemCount - 1) : -1;

  const handleKeyDown = (e: React.KeyboardEvent): boolean => {
    if (itemCount === 0) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((active + 1) % itemCount);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((active - 1 + itemCount) % itemCount);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      onPick(active);
      return true;
    }
    return false;
  };

  return { active, handleKeyDown };
}
