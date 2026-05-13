import "server-only";
import { storeBlob, isAllowedMime, sniffDimensions } from "@/lib/server/blobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 10 MB hard cap. Larger images make claude prompt token cost explode
// and the multipart parse stay in memory the whole time; both bad.
const MAX_BYTES = 10 * 1024 * 1024;

// POST /api/uploads
// Accepts either:
//   - multipart/form-data with a single file field "file"
//   - raw body with image/* Content-Type (used by paste flow when the
//     client already has a Blob and doesn't need FormData wrapping)
//
// Returns NodeAttachment-shaped JSON so the client can push it
// directly into the question's pending attachments list.
export async function POST(req: Request) {
  const ct = req.headers.get("content-type") ?? "";
  let buf: Buffer;
  let mime: string;
  let filename: string | null = null;

  try {
    if (ct.startsWith("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof Blob)) {
        return Response.json({ error: "missing 'file' field" }, { status: 400 });
      }
      mime = file.type || "application/octet-stream";
      if (!isAllowedMime(mime)) {
        return Response.json(
          { error: `unsupported mime: ${mime}` },
          { status: 415 },
        );
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
      filename =
        file instanceof File && typeof file.name === "string" && file.name
          ? file.name
          : null;
    } else if (ct.startsWith("image/")) {
      if (!isAllowedMime(ct)) {
        return Response.json(
          { error: `unsupported mime: ${ct}` },
          { status: 415 },
        );
      }
      mime = ct;
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

  const { hash, size } = storeBlob(buf, mime);
  const { width, height } = sniffDimensions(buf, mime);

  return Response.json({
    hash,
    mime,
    size,
    filename,
    width,
    height,
  });
}
