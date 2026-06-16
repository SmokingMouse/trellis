import {
  listProjects,
  listSessionsInDir,
  listRecentSessions,
  isWithinProjects,
} from "@/lib/server/cli-discover";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/cli-sync/discover            → 项目目录清单（含可 attach 会话数）
// GET /api/cli-sync/discover?dir=<path> → 该目录下的 CLI 会话摘要清单
// GET /api/cli-sync/discover?recent=1   → 跨项目最近活跃 top N（扁平，按 mtime 排）
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  if (params.get("recent")) {
    return Response.json({ sessions: listRecentSessions(40) });
  }
  const dir = params.get("dir");
  if (dir) {
    if (!isWithinProjects(dir)) {
      return Response.json(
        { error: "dir must be under ~/.claude/projects" },
        { status: 400 },
      );
    }
    return Response.json({ sessions: listSessionsInDir(dir) });
  }
  return Response.json({ projects: listProjects() });
}
