import { countBookmarks, listBookmarks } from "@/lib/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseNonNegativeInt(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const rawLimit = params.get("limit");
  const parsedLimit = rawLimit === null ? 50 : Number.parseInt(rawLimit, 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(100, Math.max(1, parsedLimit))
    : 50;
  const offset = parseNonNegativeInt(params.get("offset"), 0);
  return Response.json({
    bookmarks: listBookmarks({ limit, offset }),
    total: countBookmarks(),
    offset,
  });
}
