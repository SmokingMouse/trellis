"use client";

import { useRouter } from "next/navigation";
import { useSessionStore } from "@/stores/sessionStore";

export function BookmarkRows({ onNavigate }: { onNavigate?: () => void }) {
  const router = useRouter();
  const bookmarks = useSessionStore((s) => s.bookmarks);
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
          className="mx-1 flex min-h-11 items-stretch rounded-md text-ui text-ink-muted hover:bg-surface-muted"
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
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-unread"
                aria-label="未读"
              />
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
            className="min-h-11 shrink-0 rounded-md px-2 text-label text-ink-faint hover:bg-accent-muted hover:text-accent"
            aria-label={`读完并移除：${bookmark.question}`}
            title="从稍后再读移除（不改变已读状态）"
            onClick={() => void toggleBookmark(bookmark.nodeId, false)}
          >
            读完 ✓
          </button>
        </div>
      ))}
    </div>
  );
}
