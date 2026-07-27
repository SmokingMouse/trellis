import { listSessions, countArchivedSessions } from "@/lib/server/repo";
import { listProjectTree } from "@/lib/server/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/sessions            → active sessions only (archived excluded)
// GET /api/sessions?archived=1 → archived sessions only
// archivedCount is always returned so the picker can label its toggle
// ("显示已归档 (N)") without a second request.
//
// S1：projects（Project → Workspace 骨架）随主列表一起返回，同上理由 ——
// 侧栏一次渲染要两份数据，拆两个请求只会让它闪一下。归档视图不需要骨架。
export async function GET(req: Request) {
  const url = new URL(req.url);
  const archived = url.searchParams.get("archived") === "1";
  return Response.json({
    sessions: listSessions({ archived }),
    archivedCount: countArchivedSessions(),
    projects: archived ? [] : listProjectTree(),
  });
}
