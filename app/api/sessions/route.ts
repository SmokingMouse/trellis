import { listSessions, countArchivedSessions } from "@/lib/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/sessions            → active sessions only (archived excluded)
// GET /api/sessions?archived=1 → archived sessions only
// archivedCount is always returned so the picker can label its toggle
// ("显示已归档 (N)") without a second request.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const archived = url.searchParams.get("archived") === "1";
  return Response.json({
    sessions: listSessions({ archived }),
    archivedCount: countArchivedSessions(),
  });
}
