"use client";

import type { ChatNode } from "@/lib/types";
import { useSessionStore } from "@/stores/sessionStore";

export function BookmarkButton({
  node,
  mobileMenu = false,
  onToggle,
}: {
  node: ChatNode;
  mobileMenu?: boolean;
  onToggle?: () => void;
}) {
  const toggleBookmark = useSessionStore((s) => s.toggleBookmark);
  const saved = node.bookmarkedAt != null;
  const label = saved ? "取消稍后再读" : "稍后再读";
  return (
    <button
      type="button"
      data-mobile-target="node-bookmark-toggle"
      data-bookmarked={saved ? "true" : "false"}
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        void toggleBookmark(node.id);
        onToggle?.();
      }}
      className={
        mobileMenu
          ? "flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-ui text-ink-muted hover:bg-surface-muted hover:text-ink"
          : `hidden rounded-md px-1.5 py-1 transition-colors md:flex ${
              saved
                ? "text-accent hover:bg-accent-muted"
                : "text-ink-faint hover:bg-surface-muted hover:text-ink"
            }`
      }
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill={saved ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z" />
      </svg>
      {mobileMenu && <span>{label}</span>}
    </button>
  );
}
