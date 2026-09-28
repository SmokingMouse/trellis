"use client";

import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { useSessionStore } from "@/stores/sessionStore";
import { Icon, Spinner, StatusDot } from "@/components/ui";

export function BookmarkRows({ onNavigate }: { onNavigate?: () => void }) {
  const router = useRouter();
  const bookmarks = useSessionStore((s) => s.bookmarks);
  const bookmarksTotal = useSessionStore((s) => s.bookmarksTotal);
  const bookmarksLoadingMore = useSessionStore((s) => s.bookmarksLoadingMore);
  const loadMoreBookmarks = useSessionStore((s) => s.loadMoreBookmarks);
  const openNodeInSession = useSessionStore((s) => s.openNodeInSession);
  const setViewMode = useSessionStore((s) => s.setViewMode);
  const toggleBookmark = useSessionStore((s) => s.toggleBookmark);

  return (
    <div data-bookmark-list>
      {bookmarks.map((bookmark) => (
        <div
          key={bookmark.nodeId}
          data-mobile-target="bookmark-row"
          data-bookmark-node-id={bookmark.nodeId}
          className="mx-1 flex min-h-11 items-stretch rounded-field text-ui text-ink-muted hover:bg-surface-hover"
        >
          <button
            type="button"
            className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-2 text-left"
            title={`${bookmark.sessionTitle} · ${bookmark.question}`}
            onClick={() => {
              setViewMode("linear");
              router.replace(
                `/?session=${encodeURIComponent(bookmark.sessionId)}&node=${encodeURIComponent(bookmark.nodeId)}`,
              );
              void openNodeInSession(bookmark.sessionId, bookmark.nodeId).then(
                onNavigate,
              );
            }}
          >
            {bookmark.readAt == null && (
              <StatusDot tone="unread" label="未读" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui text-ink">
                {bookmark.sessionTitle} · {bookmark.question}
              </span>
              {bookmark.response && (
                <span className="block truncate text-nano text-ink-faint">
                  {bookmark.response}
                </span>
              )}
            </span>
          </button>
          <button
            type="button"
            data-mobile-target="bookmark-done"
            className="min-h-11 shrink-0 inline-flex items-center gap-1 rounded-field px-2 text-label text-ink-faint hover:bg-accent-muted hover:text-accent-ink"
            aria-label={`读完并移除：${bookmark.question}`}
            title="从稍后再读移除（不改变已读状态）"
            onClick={() => void toggleBookmark(bookmark.nodeId, false)}
          >
            <Icon icon={Check} size="sm" />
            读完
          </button>
        </div>
      ))}
      {bookmarksTotal > bookmarks.length && (
        <button
          type="button"
          data-mobile-target="bookmark-load-more"
          data-bookmark-remaining
          disabled={bookmarksLoadingMore}
          className="min-h-11 w-full px-3 flex items-center justify-center gap-1.5 text-label text-accent-ink hover:bg-surface-hover disabled:opacity-60"
          onClick={() => void loadMoreBookmarks()}
        >
          {bookmarksLoadingMore && <Spinner size="sm" label={null} />}
          加载更多（还有 {bookmarksTotal - bookmarks.length} 条）
        </button>
      )}
    </div>
  );
}
