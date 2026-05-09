"use client";
import type { MouseEvent } from "react";

// Tiny disclosure chip parked at the bottom-right of any card with at
// least one descendant. Two states:
//   collapsed=true  → "▶ N"  (tells the user N nodes hide here)
//   collapsed=false → "▼ N"  ("fold this subtree" entry on canvas)
// Click toggles via the onClick handler the parent passes in (which
// stops propagation so it never bubbles into ReactFlow's onNodeClick).
export function CollapseChip({
  collapsed,
  count,
  onClick,
  variant,
}: {
  collapsed: boolean;
  count: number;
  onClick: (e: MouseEvent) => void;
  variant: "compact" | "full";
}) {
  const sizeCls =
    variant === "compact"
      ? "px-1.5 py-0.5 text-[10px]"
      : "px-1.5 py-0.5 text-[11px]";
  return (
    <button
      type="button"
      onClick={onClick}
      title={collapsed ? `展开 ${count} 个被折叠的节点` : `折叠子树 (${count})`}
      aria-label={collapsed ? "展开子树" : "折叠子树"}
      aria-expanded={!collapsed}
      className={`absolute -bottom-2 right-2 z-10 inline-flex items-center gap-1 rounded-full border bg-white dark:bg-stone-900 tabular-nums shadow-sm transition-colors ${sizeCls} ${
        collapsed
          ? "border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40"
          : "border-stone-300 dark:border-stone-700 text-stone-500 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-800"
      }`}
    >
      <svg
        width="8"
        height="8"
        viewBox="0 0 12 12"
        className={`transition-transform ${collapsed ? "" : "rotate-90"}`}
        fill="currentColor"
        aria-hidden
      >
        <path d="M3 2 L9 6 L3 10 Z" />
      </svg>
      <span>{count}</span>
    </button>
  );
}
