// Shared (client + server) attachment type tables. Single source of truth
// for what can be uploaded: the upload route validates against it on the
// server, the composers gate their file pickers against it on the client.
// Pure data + string helpers — no node/server imports, safe for "use client".

// Images — the Stage 15 vision path (base64 into claude stream-json /
// codex --image). Keyed by mime because browsers report reliable image
// mimes for pastes and drags.
export const IMAGE_MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const EXT_IMAGE_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(IMAGE_MIME_EXT).map(([m, e]) => [e, m]),
);

// Generic files — the temp-file path (staged to disk + path injected into
// the prompt; text subset inlineable in pure chat). Keyed by extension
// because browsers often report "" or junk mimes for csv/log/code files;
// the extension is what the user actually sees and trusts. The mime here
// is canonical — the server overwrites whatever the client claimed.
export const FILE_EXT_MIME: Record<string, string> = {
  // text/data — inlineable in pure chat
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  log: "text/plain",
  ini: "text/plain",
  conf: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  jsonl: "application/x-ndjson",
  ndjson: "application/x-ndjson",
  yaml: "application/yaml",
  yml: "application/yaml",
  xml: "application/xml",
  toml: "application/toml",
  sql: "application/sql",
  py: "text/x-python",
  ts: "text/x-typescript",
  tsx: "text/x-typescript",
  js: "text/javascript",
  jsx: "text/javascript",
  mjs: "text/javascript",
  sh: "text/x-shellscript",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  ipynb: "application/x-ipynb+json",
  // binary — path-injection only; the agent parses these with its own tools
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  gz: "application/gzip",
  parquet: "application/vnd.apache.parquet",
};

const FILE_MIME_SET = new Set(Object.values(FILE_EXT_MIME));

// Non-text/* mimes that are still plain text on the wire (inlineable).
const TEXT_APP_MIMES = new Set([
  "application/json",
  "application/x-ndjson",
  "application/yaml",
  "application/xml",
  "application/toml",
  "application/sql",
  "application/x-ipynb+json",
]);

export function isImageMime(mime: string): boolean {
  return mime in IMAGE_MIME_EXT;
}

// Anything sanitizeAttachments should let into attachments_json.
export function isKnownAttachmentMime(mime: string): boolean {
  return mime in IMAGE_MIME_EXT || FILE_MIME_SET.has(mime);
}

// Inlineable-as-text (pure chat fallback). Everything else non-image is
// opaque binary the agent needs tools to open.
export function isTextMime(mime: string): boolean {
  return mime.startsWith("text/") || TEXT_APP_MIMES.has(mime);
}

// Lowercased extension without the dot; "" when none.
export function extOf(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

// ext → canonical mime across both tables; null when unknown.
export function mimeForExt(ext: string): string | null {
  return FILE_EXT_MIME[ext] ?? EXT_IMAGE_MIME[ext] ?? null;
}

// Classify a client-side File before uploading. Browsers lie about mimes
// for data files, so images go by mime and everything else by extension.
export function classifyFile(
  mime: string,
  filename: string | null,
): "image" | "text" | "binary" | "unsupported" {
  if (mime.startsWith("image/")) {
    return isImageMime(mime) ? "image" : "unsupported";
  }
  const canonical = filename ? FILE_EXT_MIME[extOf(filename)] : undefined;
  if (!canonical) return "unsupported";
  return isTextMime(canonical) ? "text" : "binary";
}

const IMAGE_ACCEPT = Object.keys(IMAGE_MIME_EXT).join(",");
const TEXT_EXTS = Object.entries(FILE_EXT_MIME)
  .filter(([, m]) => isTextMime(m))
  .map(([e]) => `.${e}`);
const ALL_FILE_EXTS = Object.keys(FILE_EXT_MIME).map((e) => `.${e}`);

// <input type="file" accept=…> strings per composer policy. "all" for
// tool-capable modes (project / enhanced chat); "chat-safe"
// for pure chat, which can only consume images (vision) + inlined text.
export function acceptFor(policy: "all" | "chat-safe"): string {
  const exts = policy === "all" ? ALL_FILE_EXTS : TEXT_EXTS;
  return [IMAGE_ACCEPT, ...exts].join(",");
}
