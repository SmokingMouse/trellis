import "server-only";
import fs from "node:fs";
import { resolveSessionFile } from "@/lib/server/workspace-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Map an absolute on-disk path to its /api/files URL (path segments encoded,
// leading slash dropped). Mirrors the client's filePreviewUrl so rewritten
// links and the original chip/inline links point at the same place.
function apiUrl(session: string, absPath: string): string {
  const segs = absPath
    .replace(/^\/+/, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `/api/files/${encodeURIComponent(session)}/${segs}`;
}

// GET /api/files/<sessionId>/<full-absolute-path> — stream a file the session
// touched, for preview. The URL path is the file's real absolute path (minus
// the leading slash), so HTML relative assets (./chart.js) resolve against the
// real directory structure. resolveSessionFile fences to the session whitelist.
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ session: string; path: string[] }> },
) {
  const { session, path: segs } = await ctx.params;
  const abs = "/" + (segs ?? []).map((s) => decodeURIComponent(s)).join("/");
  if (abs === "/") return new Response("missing path", { status: 400 });

  const resolved = resolveSessionFile(session, abs);
  if (!resolved) return new Response("not found", { status: 404 });

  const headers: Record<string, string> = {
    "Content-Type": resolved.mime,
    // Files change between turns — never cache.
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };

  // For HTML, rewrite absolute file:// links (e.g. a generated compare panel
  // linking sibling pages) to go back through this API. Direct file:// nav is
  // blocked from an http page / sandboxed iframe; routing them here lets the
  // page's internal navigation work, with the same whitelist enforced per hop.
  if (resolved.mime.startsWith("text/html")) {
    let html = await fs.promises.readFile(resolved.path, "utf8");
    html = html.replace(
      /((?:href|src)\s*=\s*["'])file:\/\/(\/[^"']*)/gi,
      (_m, pre, p) => `${pre}${apiUrl(session, decodeURI(p))}`,
    );
    return new Response(html, { headers });
  }

  const stream = fs.createReadStream(resolved.path);
  headers["Content-Length"] = String(resolved.size);
  return new Response(stream as unknown as ReadableStream, { headers });
}
