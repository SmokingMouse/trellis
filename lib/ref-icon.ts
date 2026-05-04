import type { ReferencePayload } from "./types";

// Single source of truth for reference card iconography. Reads
// meta.platform first (set by the claude-driven fetcher: "feishu",
// "youtube", "github", ...), falls back to sourceType for paste / unknown
// URLs. Centralized so adding a new platform icon is one edit.
const PLATFORM_ICONS: Record<string, string> = {
  feishu: "📘",
  lark: "📘",
  youtube: "🎬",
  bilibili: "📺",
  x: "🐦",
  twitter: "🐦",
  github: "🐙",
  pdf: "📕",
  notion: "📒",
  paste: "📄",
  generic: "🔗",
};

export function refIcon(ref: ReferencePayload | null | undefined): string {
  if (!ref) return "📄";
  const platform = ref.meta?.platform?.toLowerCase();
  if (platform && PLATFORM_ICONS[platform]) return PLATFORM_ICONS[platform];
  if (ref.sourceType === "paste") return "📄";
  return "🔗";
}

// Best-effort human label for the source line under the title. URL refs
// show domain; pastes show "粘贴文本".
export function refSourceLabel(
  ref: ReferencePayload | null | undefined,
): string {
  if (!ref) return "";
  if (ref.sourceType === "paste") return "粘贴文本";
  if (!ref.sourceUri) return "外部链接";
  try {
    return new URL(ref.sourceUri).hostname.replace(/^www\./, "");
  } catch {
    return ref.sourceUri;
  }
}
