import type { ReferencePayload } from "./types";

// Single source of truth for reference card iconography. Reads
// meta.platform first (set by the claude-driven fetcher: "feishu",
// "youtube", "github", ...), falls back to sourceType for paste / unknown
// URLs. Centralized so adding a new platform icon is one edit.
//
// W4：不再返回 emoji，而是返回图标 key；key → lucide 组件的映射在
// components/ui/Icon.tsx 的 REF_ICONS（同 ToolIconKey / TOOL_ICONS 的分层：
// lib 不依赖 React）。渲染用 <RefIcon name={refIconKey(ref)} />。
export type RefIconKey =
  | "doc"
  | "video"
  | "tv"
  | "social"
  | "code"
  | "pdf"
  | "notebook"
  | "paste"
  | "link";

const PLATFORM_ICONS: Record<string, RefIconKey> = {
  feishu: "doc",
  lark: "doc",
  youtube: "video",
  bilibili: "tv",
  x: "social",
  twitter: "social",
  github: "code",
  pdf: "pdf",
  notion: "notebook",
  paste: "paste",
  generic: "link",
};

export function refIconKey(ref: ReferencePayload | null | undefined): RefIconKey {
  if (!ref) return "paste";
  const platform = ref.meta?.platform?.toLowerCase();
  if (platform && PLATFORM_ICONS[platform]) return PLATFORM_ICONS[platform];
  if (ref.sourceType === "paste") return "paste";
  return "link";
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
