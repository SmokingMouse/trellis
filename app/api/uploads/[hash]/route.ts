import "server-only";
import fs from "node:fs";
import { resolveBlobPath, isValidHash } from "@/lib/server/blobs";

export const runtime = "nodejs";
export const dynamic = "force-static";

// GET /api/uploads/[hash]
// Streams a stored image blob back. Cached aggressively because hash
// is content-addressed — the URL is immutable for the life of the file.
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ hash: string }> },
) {
  const { hash } = await ctx.params;
  if (!isValidHash(hash)) {
    return new Response("invalid hash", { status: 400 });
  }
  const resolved = resolveBlobPath(hash);
  if (!resolved) {
    return new Response("not found", { status: 404 });
  }
  // Node 20+ supports passing a readable web stream directly; the
  // built-in Response handles backpressure.
  const stat = fs.statSync(resolved.path);
  const stream = fs.createReadStream(resolved.path);
  // Cast through unknown — Node's ReadStream is a Web-compatible
  // ReadableStream in this runtime but the type system doesn't always
  // see it as one without explicit assertion.
  return new Response(stream as unknown as ReadableStream, {
    headers: {
      "Content-Type": resolved.mime,
      "Content-Length": String(stat.size),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
