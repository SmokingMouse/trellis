import type { Bookmark } from "@/lib/types";

export const BOOKMARK_QUESTION_LIMIT = 80;
export const BOOKMARK_RESPONSE_LIMIT = 120;

// A bookmarks response is a bounded, newest-first window. Only nodes named
// by that window are authoritative: an absent loaded node may simply be item
// 51+, so its local bookmark mark must remain untouched.
export function mergeBookmarkWindowIntoNodes<
  T extends { bookmarkedAt?: number | null },
>(
  nodes: Record<string, T>,
  bookmarks: Array<Pick<Bookmark, "nodeId" | "bookmarkedAt">>,
): Record<string, T> {
  let next = nodes;
  for (const bookmark of bookmarks) {
    const node = nodes[bookmark.nodeId];
    if (!node || (node.bookmarkedAt ?? null) === bookmark.bookmarkedAt) continue;
    if (next === nodes) next = { ...nodes };
    next[bookmark.nodeId] = {
      ...node,
      bookmarkedAt: bookmark.bookmarkedAt,
    };
  }
  return next;
}

// C2-2: nodes the client marked bookmarked locally that the current window
// doesn't vouch for one way or the other. The window is newest-first and
// bounded, so an absent id might just be paginated out — these are the only
// ones worth a targeted server round-trip to tell "still bookmarked" apart
// from "unbookmarked elsewhere".
export function staleBookmarkCandidateIds<
  T extends { id: string; bookmarkedAt?: number | null },
>(nodes: Record<string, T>, windowNodeIds: Iterable<string>): string[] {
  const windowSet = new Set(windowNodeIds);
  return Object.values(nodes)
    .filter((node) => node.bookmarkedAt != null && !windowSet.has(node.id))
    .map((node) => node.id);
}

// Bookmark rows are navigation aids, not another markdown renderer. Flatten
// the common markdown constructs before truncating so the sidebar never shows
// syntax noise such as `**`, link destinations, or heading markers.
export function bookmarkSummary(source: string, limit: number): string {
  const plain = source
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(plain);
  if (chars.length <= limit) return plain;
  if (limit <= 0) return "";
  return `${chars.slice(0, limit - 1).join("")}…`;
}
