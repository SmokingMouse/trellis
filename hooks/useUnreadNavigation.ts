"use client";
import { useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import type { ChatNode } from "@/lib/types";

// Global J / K → jump to next / previous unread node, in createdAt order.
// Wraps around. Skipped while typing in inputs / textareas / contentEditable.
// Cards on canvas auto-pan to the new active node (Canvas effect on
// activeNodeId); fullscreen view auto-loads the new active node. We don't
// auto-toggle fullScreen — staying in whichever layer the user picked.
//
// Vim convention (and Gmail / Twitter / Reddit): j = down/next, k = up/prev.
export function useUnreadNavigation() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "j" && e.key !== "J" && e.key !== "k" && e.key !== "K") {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      const direction: 1 | -1 = e.key === "j" || e.key === "J" ? 1 : -1;
      const store = useSessionStore.getState();
      const target = findNeighborUnread(
        store.nodes,
        store.activeNodeId,
        direction,
      );
      if (!target) return;
      e.preventDefault();
      store.setActiveNode(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function isUnreadNode(n: ChatNode): boolean {
  return n.status === "done" && !n.readAt;
}

// Walk createdAt-ordered list from activeId in `direction`, wrapping. Returns
// the first unread node id encountered, or null if every node is read /
// streaming / errored. We start `i = 1` so the active node itself isn't a
// hit (otherwise pressing J on a freshly-streamed unread would do nothing).
function findNeighborUnread(
  nodes: Record<string, ChatNode>,
  activeId: string | null,
  direction: 1 | -1,
): string | null {
  const list = Object.values(nodes).sort(
    (a, b) => a.createdAt - b.createdAt,
  );
  if (list.length === 0) return null;
  const startIdx = activeId
    ? list.findIndex((n) => n.id === activeId)
    : direction === 1
      ? -1 // forward from "before the first" → first node
      : 0; // backward from "the first" → wraps to last
  for (let i = 1; i <= list.length; i++) {
    const raw = (startIdx ?? -1) + direction * i;
    const idx = ((raw % list.length) + list.length) % list.length;
    if (isUnreadNode(list[idx])) return list[idx].id;
  }
  return null;
}
