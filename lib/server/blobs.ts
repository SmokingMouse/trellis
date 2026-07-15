import "server-only";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  IMAGE_MIME_EXT,
  FILE_EXT_MIME,
  mimeForExt,
  isImageMime,
} from "@/lib/attachments";
import type { NodeAttachment } from "@/lib/types";

const BLOB_DIR = path.join(os.homedir(), ".trellis", "blobs");
// Per-node staging dirs for generic file attachments. Blobs are
// content-addressed (<hash>.<ext>) which is great for dedup but useless
// as a filename for the agent — staging re-materializes them under their
// original names so "data.csv" reads as data.csv in prompts and tool
// calls. Keyed by nodeId so a retry rebuilds the exact same paths.
const UPLOADS_DIR = path.join(os.homedir(), ".trellis", "uploads");

// Every extension a blob can be stored under (images + generic files).
const ALL_EXTS = [
  ...Object.values(IMAGE_MIME_EXT),
  ...Object.keys(FILE_EXT_MIME),
];

export function isAllowedMime(mime: string): boolean {
  return isImageMime(mime);
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

// Write a buffer to ~/.trellis/blobs/<hash>.<ext> if not already present.
// The caller has already validated/canonicalized ext against the shared
// whitelist (upload route) — this layer just refuses anything off-table
// so nothing exotic lands in the blob dir as a side channel.
export function storeBlob(
  buf: Buffer,
  ext: string,
): { hash: string; size: number; alreadyExisted: boolean; path: string } {
  if (!ALL_EXTS.includes(ext)) {
    throw new Error(`unsupported extension: ${ext}`);
  }
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  const filePath = path.join(BLOB_DIR, `${hash}.${ext}`);
  if (fs.existsSync(filePath)) {
    return { hash, size: buf.length, alreadyExisted: true, path: filePath };
  }
  ensureDir(BLOB_DIR);
  fs.writeFileSync(filePath, buf);
  return { hash, size: buf.length, alreadyExisted: false, path: filePath };
}

// Resolve hash → on-disk path. Returns null if not found. The route
// handler hard-rejects malformed hashes (not 64 hex chars) before
// calling this, so path traversal isn't a concern.
export function resolveBlobPath(
  hash: string,
): { path: string; mime: string } | null {
  for (const ext of ALL_EXTS) {
    const p = path.join(BLOB_DIR, `${hash}.${ext}`);
    if (fs.existsSync(p)) {
      return { path: p, mime: mimeForExt(ext) ?? "application/octet-stream" };
    }
  }
  return null;
}

export function isValidHash(h: string): boolean {
  return /^[a-f0-9]{64}$/i.test(h);
}

// Strip anything that could escape the staging dir or garble a prompt
// line: path separators, control chars, leading dots. Caps length while
// preserving the extension. Returns null for names that sanitize away to
// nothing (caller falls back to a hash-derived name).
export function sanitizeFilename(name: string | null): string | null {
  if (!name) return null;
  const base = (name.split(/[/\\]/).pop() ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .replace(/^\.+/, "");
  if (!base) return null;
  if (base.length <= 80) return base;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot) : "";
  return base.slice(0, 80 - ext.length) + ext;
}

export type StagedAttachment = {
  path: string; // absolute path the agent can Read/Bash
  filename: string; // final (sanitized, de-duplicated) name
  mime: string;
  size: number;
};

// Materialize a node's generic-file attachments (non-image) into
// ~/.trellis/uploads/<nodeId>/<original-filename>. Idempotent: same node +
// same attachments → same paths every time (copyFileSync overwrites), so
// retries re-stage for free. Missing blobs are skipped, mirroring
// resolveAttachments' behavior for images.
export function materializeAttachments(
  nodeId: string,
  attachments: NodeAttachment[],
): StagedAttachment[] {
  const dir = path.join(UPLOADS_DIR, nodeId);
  const used = new Set<string>();
  const out: StagedAttachment[] = [];
  for (const a of attachments) {
    const blob = resolveBlobPath(a.hash);
    if (!blob) continue;
    const ext = path.extname(blob.path).slice(1);
    const base =
      sanitizeFilename(a.filename) ?? `file-${a.hash.slice(0, 8)}.${ext}`;
    // De-dup within the node (two different files both named data.csv):
    // deterministic -2/-3 suffixes keep retry paths stable.
    let name = base;
    for (let i = 2; used.has(name); i++) {
      const dot = base.lastIndexOf(".");
      name = dot > 0 ? `${base.slice(0, dot)}-${i}${base.slice(dot)}` : `${base}-${i}`;
    }
    used.add(name);
    ensureDir(dir);
    const dest = path.join(dir, name);
    fs.copyFileSync(blob.path, dest);
    out.push({ path: dest, filename: name, mime: a.mime, size: a.size });
  }
  return out;
}

// Read a text blob for pure-chat inlining. Returns null when the blob is
// missing or over the cap — the caller notes "too large" in the prompt
// instead of blowing the context window.
export function readTextBlob(hash: string, capBytes: number): string | null {
  const blob = resolveBlobPath(hash);
  if (!blob) return null;
  const stat = fs.statSync(blob.path);
  if (stat.size > capBytes) return null;
  return fs.readFileSync(blob.path, "utf8");
}

// Minimal header-byte dimension sniff for the formats we accept. Reads
// only the first few dozen bytes — no full decode. Returns undefined
// when the format is recognized but its dimension header isn't where
// expected (corrupt file, exotic encoding), or when we don't support
// the format at all (e.g. WebP variants). Undefined just means the
// client falls back to natural <img> dims at render time.
export function sniffDimensions(
  buf: Buffer,
  mime: string,
): { width?: number; height?: number } {
  if (mime === "image/png" && buf.length >= 24) {
    // PNG sig: 89 50 4E 47 0D 0A 1A 0A, then IHDR (length 13) starts
    // at offset 8. Width is uint32be at 16, height at 20.
    if (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    ) {
      return {
        width: buf.readUInt32BE(16),
        height: buf.readUInt32BE(20),
      };
    }
  }
  if (mime === "image/gif" && buf.length >= 10) {
    // GIF87a / GIF89a, LE width@6, LE height@8.
    if (
      buf[0] === 0x47 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46
    ) {
      return {
        width: buf.readUInt16LE(6),
        height: buf.readUInt16LE(8),
      };
    }
  }
  if (mime === "image/jpeg") {
    // Scan for SOF marker (FFC0-FFCF except FFC4/FFC8/FFCC) — those
    // carry height/width as big-endian uint16 at offsets +5 / +7 from
    // the marker byte. Skip the initial FFD8 and any other markers
    // with length-prefixed segments. Caps at first 64KB so a malformed
    // file can't drag this into a long loop.
    const maxScan = Math.min(buf.length, 65536);
    let i = 2; // skip SOI
    while (i + 8 < maxScan) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        // SOI/EOI have no payload
        i += 2;
        continue;
      }
      const isSof =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc;
      if (isSof) {
        return {
          height: buf.readUInt16BE(i + 5),
          width: buf.readUInt16BE(i + 7),
        };
      }
      const segLen = buf.readUInt16BE(i + 2);
      i += 2 + segLen;
    }
  }
  return {};
}
