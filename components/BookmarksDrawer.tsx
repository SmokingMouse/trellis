"use client";

import { useEffect, useRef } from "react";
import { BookmarkRows } from "@/components/BookmarkRows";
import { X, BookmarkCheck } from "lucide-react";
import { Drawer, EmptyState, Icon } from "@/components/ui";
import { useSessionStore } from "@/stores/sessionStore";

export function BookmarksDrawer() {
  const open = useSessionStore((s) => s.bookmarksOpen);
  const bookmarks = useSessionStore((s) => s.bookmarks);
  const bookmarksTotal = useSessionStore((s) => s.bookmarksTotal);
  const setOpen = useSessionStore((s) => s.setBookmarksOpen);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    let frame = 0;
    if (open && !wasOpenRef.current) {
      wasOpenRef.current = true;
      frame = requestAnimationFrame(() => closeRef.current?.focus());
    } else if (!open && wasOpenRef.current) {
      wasOpenRef.current = false;
      frame = requestAnimationFrame(() => {
        document
          .querySelector<HTMLButtonElement>(
            '[data-mobile-target="header-overflow"]',
          )
          ?.focus();
      });
    }
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return (
    <Drawer open={open} onClose={() => setOpen(false)} title="稍后再读">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="稍后再读"
        data-bookmarks-drawer
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex min-h-12 shrink-0 items-center border-b border-line px-4">
          <h2 className="flex-1 text-sm font-semibold text-ink-strong">
            稍后再读 ({bookmarksTotal})
          </h2>
          <button
            ref={closeRef}
            type="button"
            data-mobile-target="bookmarks-close"
            className="-mr-2 flex min-h-11 min-w-11 items-center justify-center rounded-field text-ink-muted hover:bg-surface-hover hover:text-ink"
            aria-label="关闭稍后再读"
            onClick={() => setOpen(false)}
          >
            <Icon icon={X} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
          {bookmarks.length > 0 ? (
            <BookmarkRows onNavigate={() => setOpen(false)} />
          ) : (
            <EmptyState
              compact
              icon={BookmarkCheck}
              title="还没有稍后再读的卡片"
              description="在卡片上点「稍后再读」，它会出现在这里。"
            />
          )}
        </div>
      </section>
    </Drawer>
  );
}
