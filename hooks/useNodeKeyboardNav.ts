"use client";
import { useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { isEditableTarget } from "@/lib/shortcuts";

// A5: Alt+Arrow keyboard navigation across the node tree. Alt avoids clashing
// with ReactFlow pan (bare arrows) and the J/K unread nav. Up = parent,
// Down = first child, Left/Right = prev/next sibling. No-op while typing.
export function useNodeKeyboardNav() {
  const nodes = useSessionStore((s) => s.nodes);
  const activeNodeId = useSessionStore((s) => s.activeNodeId);
  const setActiveNode = useSessionStore((s) => s.setActiveNode);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      if (!e.key.startsWith("Arrow")) return;
      if (isEditableTarget(document.activeElement)) return;
      if (!activeNodeId) return;
      const node = nodes[activeNodeId];
      if (!node) return;

      let targetId: string | null = null;
      if (e.key === "ArrowUp") {
        targetId = node.parentId;
      } else if (e.key === "ArrowDown") {
        const children = Object.values(nodes)
          .filter((n) => n.parentId === activeNodeId)
          .sort((a, b) => a.siblingIndex - b.siblingIndex);
        targetId = children[0]?.id ?? null;
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const siblings = Object.values(nodes)
          .filter((n) => n.parentId === node.parentId)
          .sort((a, b) => a.siblingIndex - b.siblingIndex);
        const idx = siblings.findIndex((n) => n.id === activeNodeId);
        if (idx >= 0) {
          const next =
            e.key === "ArrowLeft" ? siblings[idx - 1] : siblings[idx + 1];
          targetId = next?.id ?? null;
        }
      }
      if (targetId) {
        e.preventDefault();
        setActiveNode(targetId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nodes, activeNodeId, setActiveNode]);
}
