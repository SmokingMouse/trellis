export const BOOKMARK_QUESTION_LIMIT = 80;
export const BOOKMARK_RESPONSE_LIMIT = 120;

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
  return Array.from(plain).slice(0, limit).join("");
}
