"use client";

import { BookmarkRows } from "@/components/BookmarkRows";
import { Drawer } from "@/components/ui/Drawer";
import { useSessionStore } from "@/stores/sessionStore";

export function BookmarksDrawer() {
  const open = useSessionStore((s) => s.bookmarksOpen);
  const bookmarks = useSessionStore((s) => s.bookmarks);
  const bookmarksTotal = useSessionStore((s) => s.bookmarksTotal);
  const setOpen = useSessionStore((s) => s.setBookmarksOpen);
  return (
    <Drawer open={open} onClose={() => setOpen(false)}>
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
            type="button"
            data-mobile-target="bookmarks-close"
            className="-mr-2 flex min-h-11 min-w-11 items-center justify-center rounded-md text-ink-muted hover:bg-surface-muted"
            aria-label="关闭稍后再读"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
          {bookmarks.length > 0 ? (
            <BookmarkRows onNavigate={() => setOpen(false)} />
          ) : (
            <div className="px-4 py-8 text-center text-ui text-ink-faint">
              还没有稍后再读的卡片
            </div>
          )}
        </div>
      </section>
    </Drawer>
  );
}
