import { searchAll } from "@/lib/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/search?q=<query>&limit=<n>
// Server-side caps: limit defaults to 80, hard ceiling 200. Client groups
// hits by session, so 80 raw hits typically render as 10-30 session groups.
// trigram tokenizer requires ≥ 3 chars; shorter queries return [] without
// hitting the DB (see repo.searchAll / buildFtsQuery).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const limitParam = url.searchParams.get("limit");
  let limit = 80;
  if (limitParam) {
    const n = Number.parseInt(limitParam, 10);
    if (Number.isFinite(n) && n > 0) limit = Math.min(n, 200);
  }
  const results = searchAll(q, limit);
  return Response.json({ results });
}
