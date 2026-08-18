import {
  listProjects,
  listSessionsInProject,
  listRecentSessions,
  isWithinProjects,
  type CliProvider,
} from "@/lib/server/cli-discover";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/cli-sync/discover            → 项目目录清单（含可 attach 会话数）
// GET /api/cli-sync/discover?dir=<path> → 该目录下的 CLI 会话摘要清单
// GET /api/cli-sync/discover?recent=1   → 跨项目最近活跃 top N（扁平，按 mtime 排）
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const rawProvider = params.get("provider") ?? "claude";
  if (rawProvider !== "claude" && rawProvider !== "codex") {
    return Response.json({ error: "provider must be claude or codex" }, { status: 400 });
  }
  const provider = rawProvider as CliProvider;
  if (params.get("recent")) {
    return Response.json({ sessions: listRecentSessions(40, provider) });
  }
  const project = params.get("project");
  // Legacy query name remains accepted for bookmarked/dev URLs.
  const key = project ?? params.get("dir");
  if (key !== null) {
    if (provider === "claude" && !isWithinProjects(key)) {
      return Response.json(
        { error: "dir must be under ~/.claude/projects" },
        { status: 400 },
      );
    }
    return Response.json({ sessions: listSessionsInProject(provider, key) });
  }
  return Response.json({ projects: listProjects(provider) });
}
