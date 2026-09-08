import { getBookmarkStatuses } from "@/lib/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// C2-2: targeted reconciliation endpoint. The client calls this with the ids
// of nodes it locally believes are bookmarked but that fell outside the
// bounded /api/bookmarks window, so it can tell "still bookmarked, just
// paginated out" apart from "unbookmarked elsewhere" without refetching
// everything.
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("ids") ?? "";
  const ids = [
    ...new Set(
      raw
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ].slice(0, 200);
  return Response.json({ statuses: getBookmarkStatuses(ids) });
}
