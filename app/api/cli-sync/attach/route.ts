import {
  attachSession,
  detachSession,
} from "@/lib/server/cli-sync-watcher";
import { isWithinProjects } from "@/lib/server/cli-discover";
import { listSessions } from "@/lib/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  /api/cli-sync/attach              → 当前已 attach 的会话清单
// POST /api/cli-sync/attach  { action: "attach", jsonlPath }
//                            { action: "detach", sessionId }
//   attach → 导入 + 起实时 watch（trellis 续聊走 project resume 写回原 jsonl）
//   detach → 删 trellis 侧 session + 停 watch（不动原始 jsonl）
export async function GET() {
  const attached = listSessions()
    .filter((s) => s.origin === "cli-import")
    .map((s) => ({
      id: s.id,
      title: s.title,
      sourceJsonlPath: s.sourceJsonlPath,
      workspacePath: s.workspacePath,
      updatedAt: s.updatedAt,
    }));
  return Response.json({ attached });
}

export async function POST(req: Request) {
  let body: { action?: unknown; jsonlPath?: unknown; sessionId?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }
  const action = body.action ?? "attach";
  try {
    if (action === "detach") {
      if (typeof body.sessionId !== "string") {
        return Response.json(
          { error: "sessionId required for detach" },
          { status: 400 },
        );
      }
      detachSession(body.sessionId);
      return Response.json({ ok: true, action: "detach", sessionId: body.sessionId });
    }
    // attach
    const jsonlPath = body.jsonlPath;
    if (
      typeof jsonlPath !== "string" ||
      !jsonlPath.endsWith(".jsonl") ||
      !isWithinProjects(jsonlPath)
    ) {
      return Response.json(
        { error: "jsonlPath must be a .jsonl under ~/.claude/projects" },
        { status: 400 },
      );
    }
    const stats = attachSession(jsonlPath);
    return Response.json({ ok: true, action: "attach", result: stats });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
