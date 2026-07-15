import "server-only";
import { storeBlob, sniffDimensions } from "@/lib/server/blobs";
import {
  IMAGE_MIME_EXT,
  FILE_EXT_MIME,
  isImageMime,
  extOf,
} from "@/lib/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 10 MB hard cap. Larger images make claude prompt token cost explode
// and the multipart parse stay in memory the whole time; both bad.
// Generic files share the cap — the agent reads them from disk, but the
// upload itself is still buffered in memory here.
const MAX_BYTES = 10 * 1024 * 1024;

// POST /api/uploads
// Accepts either:
//   - multipart/form-data with a single file field "file" — images AND
//     generic files (csv/log/pdf/…). Generic files are validated by
//     extension against the shared whitelist and get their canonical
//     mime from it (browsers report "" or junk for data files).
//   - raw body with image/* Content-Type (used by paste flow when the
//     client already has a Blob and doesn't need FormData wrapping).
//     Images only — generic files must come through multipart so we
//     have a filename to derive the extension from.
//
// Returns NodeAttachment-shaped JSON so the client can push it
// directly into the question's pending attachments list.
export async function POST(req: Request) {
  const ct = req.headers.get("content-type") ?? "";
  let buf: Buffer;
  let mime: string;
  let ext: string;
  let filename: string | null = null;

  try {
    if (ct.startsWith("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof Blob)) {
        return Response.json({ error: "missing 'file' field" }, { status: 400 });
      }
      filename =
        file instanceof File && typeof file.name === "string" && file.name
          ? file.name
          : null;
      const claimed = file.type || "";
      if (claimed.startsWith("image/")) {
        if (!isImageMime(claimed)) {
          return Response.json(
            { error: `unsupported mime: ${claimed}` },
            { status: 415 },
          );
        }
        mime = claimed;
        ext = IMAGE_MIME_EXT[claimed];
      } else {
        const fromName = filename ? extOf(filename) : "";
        const canonical = FILE_EXT_MIME[fromName];
        if (!canonical) {
          return Response.json(
            { error: `unsupported file type: ${fromName ? `.${fromName}` : "(no extension)"}` },
            { status: 415 },
          );
        }
        mime = canonical;
        ext = fromName;
      }
      // Blob is a Web type; Buffer.from(ArrayBuffer) handles the conversion.
      const ab = await file.arrayBuffer();
      if (ab.byteLength > MAX_BYTES) {
        return Response.json(
          { error: `file too large (max ${MAX_BYTES} bytes)` },
          { status: 413 },
        );
      }
      buf = Buffer.from(ab);
    } else if (ct.startsWith("image/")) {
      if (!isImageMime(ct)) {
        return Response.json(
          { error: `unsupported mime: ${ct}` },
          { status: 415 },
        );
      }
      mime = ct;
      ext = IMAGE_MIME_EXT[ct];
      const ab = await req.arrayBuffer();
      if (ab.byteLength > MAX_BYTES) {
        return Response.json(
          { error: `file too large (max ${MAX_BYTES} bytes)` },
          { status: 413 },
        );
      }
      buf = Buffer.from(ab);
    } else {
      return Response.json(
        { error: "expected multipart/form-data or image/* body" },
        { status: 400 },
      );
    }
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  const { hash, size } = storeBlob(buf, ext);
  const { width, height } = mime.startsWith("image/")
    ? sniffDimensions(buf, mime)
    : { width: undefined, height: undefined };

  return Response.json({
    hash,
    mime,
    size,
    filename,
    width,
    height,
  });
}
