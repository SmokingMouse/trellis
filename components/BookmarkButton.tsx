"use client";

import { Bookmark } from "lucide-react";
import { Icon } from "@/components/ui";
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
          ? "flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-ui text-ink-muted hover:bg-surface-hover hover:text-ink"
          : `hidden rounded-md px-1.5 py-1 transition-colors md:flex ${
              saved
                ? "text-accent-ink hover:bg-accent-muted"
                : "text-ink-faint hover:bg-surface-hover hover:text-ink"
            }`
      }
    >
      <Icon icon={Bookmark} size="sm" fill={saved ? "currentColor" : "none"} />
      {mobileMenu && <span>{label}</span>}
    </button>
  );
}
