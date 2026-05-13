import "server-only";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const BLOB_DIR = path.join(os.homedir(), ".trellis", "blobs");

// Mime whitelist + extension map. Anything outside this is rejected at
// upload time so we don't accidentally store .exe / .pdf / etc. in the
// blob dir as a side channel.
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function isAllowedMime(mime: string): boolean {
  return mime in MIME_EXT;
}

function ensureDir() {
  fs.mkdirSync(BLOB_DIR, { recursive: true });
}

// Write a buffer to ~/.trellis/blobs/<hash>.<ext> if not already present.
// Returns { hash, size, alreadyExisted, path } — alreadyExisted lets the
// upload route skip the write fsync entirely and return a fast 200.
export function storeBlob(
  buf: Buffer,
  mime: string,
): { hash: string; size: number; alreadyExisted: boolean; path: string } {
  if (!isAllowedMime(mime)) {
    throw new Error(`unsupported mime: ${mime}`);
  }
  const ext = MIME_EXT[mime];
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  const filePath = path.join(BLOB_DIR, `${hash}.${ext}`);
  if (fs.existsSync(filePath)) {
    return { hash, size: buf.length, alreadyExisted: true, path: filePath };
  }
  ensureDir();
  fs.writeFileSync(filePath, buf);
  return { hash, size: buf.length, alreadyExisted: false, path: filePath };
}

// Resolve hash → on-disk path. Returns null if not found. The route
// handler hard-rejects malformed hashes (not 64 hex chars) before
// calling this, so path traversal isn't a concern.
export function resolveBlobPath(hash: string): { path: string; mime: string } | null {
  for (const [mime, ext] of Object.entries(MIME_EXT)) {
    const p = path.join(BLOB_DIR, `${hash}.${ext}`);
    if (fs.existsSync(p)) return { path: p, mime };
  }
  return null;
}

export function isValidHash(h: string): boolean {
  return /^[a-f0-9]{64}$/i.test(h);
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
