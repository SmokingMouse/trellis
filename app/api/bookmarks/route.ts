import { countBookmarks, listBookmarks } from "@/lib/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("limit");
  const parsed = raw === null ? 50 : Number.parseInt(raw, 10);
  const limit = Number.isFinite(parsed)
    ? Math.min(100, Math.max(1, parsed))
    : 50;
  return Response.json({
    bookmarks: listBookmarks({ limit }),
    total: countBookmarks(),
  });
}
