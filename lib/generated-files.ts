import type { ChatNode } from "./types";

// Tools whose calls mean "a file was written/changed" — the ones worth
// offering a preview for. Read/Bash/Grep are excluded (no deterministic
// output path). NotebookEdit uses notebook_path instead of file_path.
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export type GeneratedFile = { absPath: string; name: string };

// Pull the distinct files this node's turn wrote/edited, in first-seen order.
// Absolute paths only (tool calls report absolute) — the server fences these to
// the session whitelist, so we don't pre-filter by workspace here.
export function generatedFilesFromNode(node: ChatNode): GeneratedFile[] {
  const seen = new Map<string, GeneratedFile>();
  for (const tc of node.toolCalls) {
    if (!WRITE_TOOLS.has(tc.name)) continue;
    const input = tc.input as Record<string, unknown> | null;
    if (!input || typeof input !== "object") continue;
    const fp = input.file_path ?? input.notebook_path;
    if (typeof fp !== "string" || !fp.startsWith("/")) continue;
    if (!seen.has(fp)) {
      seen.set(fp, { absPath: fp, name: fp.split("/").pop() || fp });
    }
  }
  return [...seen.values()];
}

// Build the preview URL from an ABSOLUTE on-disk path: the path (minus leading
// slash) becomes the URL path so the page's relative assets and rewritten
// file:// links resolve against the real directory structure. The server
// validates against the session whitelist.
export function filePreviewUrl(sessionId: string, absPath: string): string {
  const segs = absPath
    .replace(/^\/+/, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `/api/files/${encodeURIComponent(sessionId)}/${segs}`;
}

// Extensions we offer a preview for. Mirrors the server mime table; anything
// else stays plain text (no clickable affordance).
const PREVIEWABLE_EXT =
  /\.(html?|svg|png|jpe?g|gif|webp|pdf|md|markdown|json|css|m?js|tsx?|jsx|py|csv|ya?ml|toml|sh|sql|go|rs|java|rb|txt|xml)$/i;

// Decide whether an inline-code string is a previewable file path, returning
// the ABSOLUTE path (for filePreviewUrl) or null. Strict, to keep false
// positives low: must contain a separator, carry a known extension, not be a
// URL. Absolute paths pass through; "~/" can't be expanded client-side (skip);
// relative paths resolve against the workspace cwd. The server still fences the
// result to the session whitelist, so a stray match just 404s on click.
export function previewablePath(
  text: string,
  workspace: string | null,
): string | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  if (!t.includes("/")) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return null; // URL scheme
  if (!PREVIEWABLE_EXT.test(t)) return null;
  if (t.startsWith("/")) return t;
  if (t.startsWith("~")) return null;
  if (!workspace) return null;
  return workspace.replace(/\/+$/, "") + "/" + t.replace(/^\.\//, "");
}

// Resolve a markdown <a href> to a previewable ABSOLUTE local path, or null.
// Looser than previewablePath: the author explicitly linked it, so bare
// relative names ("README.md") count too. file:// unwraps to its path;
// any other scheme (http, mailto, …) is not a local file.
export function previewableHref(
  href: string,
  workspace: string | null,
): string | null {
  let h = href.trim();
  if (!h || h.startsWith("#")) return null;
  const fileScheme = h.match(/^file:\/\/(?:localhost)?(\/.*)$/i);
  if (fileScheme) {
    try {
      h = decodeURIComponent(fileScheme[1]);
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(h)) {
    return null;
  }
  if (!PREVIEWABLE_EXT.test(h)) return null;
  if (h.startsWith("/")) return h;
  if (h.startsWith("~")) return null;
  if (!workspace) return null;
  return workspace.replace(/\/+$/, "") + "/" + h.replace(/^\.\//, "");
}

// http(s) URL whose path names an image — previewable in a hover card via a
// plain <img> (images load cross-origin without CORS).
export function remoteImageHref(href: string): boolean {
  try {
    const u = new URL(href);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      /\.(png|jpe?g|gif|webp|svg)$/i.test(u.pathname)
    );
  } catch {
    return false;
  }
}

export type PreviewKind = "html" | "image" | "pdf" | "markdown" | "text";

export function previewKind(name: string): PreviewKind {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "html";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext))
    return "image";
  if (ext === ".pdf") return "pdf";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  return "text";
}
