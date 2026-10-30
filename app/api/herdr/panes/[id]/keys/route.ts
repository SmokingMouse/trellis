import {
  HerdrApiError,
  HerdrUnavailableError,
  isHerdrPromptChanged,
} from "@/lib/server/herdr-client";
import { getHerdrFleetService } from "@/lib/server/herdr-fleet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  // expectedRev：卡片上对话框的 rev（pending 接口 / herdrScreenRev）。带了就在发键前重读屏幕核对，
  // 对不上回 409 prompt_changed、什么都不按；不带的旧调用照常直接发。
  let body: { keys?: unknown; expectedRev?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (
    !Array.isArray(body.keys) ||
    body.keys.length === 0 ||
    body.keys.length > 32 ||
    body.keys.some((key) => typeof key !== "string" || !key || key.length > 32 || /[\u0000-\u001f\u007f]/.test(key))
  ) {
    return Response.json({ error: "expected non-empty { keys: string[] }" }, { status: 400 });
  }
  if (body.expectedRev !== undefined && (typeof body.expectedRev !== "string" || body.expectedRev.length > 64)) {
    return Response.json({ error: "expectedRev must be a string" }, { status: 400 });
  }
  const { id } = await context.params;
  try {
    const service = getHerdrFleetService();
    await service.ensureStarted();
    const result = await service.keys(id, body.keys as string[], body.expectedRev as string | undefined);
    return Response.json({ ok: true, result });
  } catch (error) {
    if (isHerdrPromptChanged(error)) {
      return Response.json(
        { error: error.message, code: "prompt_changed", delivered: "none", rev: error.rev, prompt: error.prompt },
        { status: 409 },
      );
    }
    const status =
      error instanceof HerdrUnavailableError
        ? 503
        : error instanceof HerdrApiError && error.code === "not_agent_pane"
          ? 403
        : error instanceof HerdrApiError && error.code === "pane_not_found"
          ? 404
          : 502;
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status },
    );
  }
}
