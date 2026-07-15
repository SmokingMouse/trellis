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
      ? "px-1.5 py-0.5 text-nano"
      : "px-1.5 py-0.5 text-label";
  return (
    <button
      type="button"
      onClick={onClick}
      title={collapsed ? `展开 ${count} 个被折叠的节点` : `折叠子树 (${count})`}
      aria-label={collapsed ? "展开子树" : "折叠子树"}
      aria-expanded={!collapsed}
      className={`absolute -bottom-2 right-2 z-10 inline-flex items-center gap-1 rounded-full border bg-surface tabular-nums shadow-raise transition-colors ${sizeCls} ${
        collapsed
          ? "border-warn-line text-warn-ink hover:bg-warn-muted" /* TODO(w5): 折叠计数 chip 复用 warn hue，语义待裁决 */
          : "border-line-strong text-ink-muted hover:bg-surface-muted"
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
