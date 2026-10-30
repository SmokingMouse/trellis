import {
  HerdrApiError,
  HerdrUnavailableError,
} from "@/lib/server/herdr-client";
import { getHerdrFleetService } from "@/lib/server/herdr-fleet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { workspaceId?: unknown; cwd?: unknown; label?: unknown; agent?: unknown } = {};
  try {
    const text = await req.text();
    if (text.trim()) {
      body = JSON.parse(text);
    }
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : undefined;
  const cwd = typeof body.cwd === "string" ? body.cwd.trim() : undefined;
  const label = typeof body.label === "string" ? body.label.trim() : undefined;
  // agent: "claude" → 新 Tab 里直接起 claude（trellis 拉起，带阻塞 hook）；其余值忽略。
  const agent = body.agent === "claude" ? "claude" : undefined;

  try {
    const service = getHerdrFleetService();
    await service.ensureStarted();
    const result = await service.createTab({ workspaceId, cwd, label, agent });
    return Response.json({ ok: true, result });
  } catch (error) {
    const status =
      error instanceof HerdrUnavailableError
        ? 503
        : error instanceof HerdrApiError
          ? 400
          : 502;
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status },
    );
  }
}
