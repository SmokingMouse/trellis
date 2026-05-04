"use client";
import { useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";

// Global Esc → abort the in-flight stream.
//
// Picks the active node if it's currently streaming; otherwise falls back
// to the most recently started stream (insertion order in the controllers
// map). Esc inside textareas / inputs is left alone — those have local
// semantics (close popovers, etc.).
export function useEscapeAbort() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      const store = useSessionStore.getState();
      const active = store.activeNodeId;
      const activeNode = active ? store.nodes[active] : null;
      let target: string | null = null;
      if (activeNode?.status === "streaming") {
        target = active;
      } else {
        target = store.latestStreamingNodeId();
      }
      if (!target) return;
      e.preventDefault();
      store.abortStream(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
