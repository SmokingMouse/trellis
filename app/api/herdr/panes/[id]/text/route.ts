import {
  HerdrApiError,
  HerdrUnavailableError,
} from "@/lib/server/herdr-client";
import { getHerdrFleetService } from "@/lib/server/herdr-fleet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 立即把文字打进窗格（不像 /input 那样等窗格空闲再排队送达）。
// 用于选择卡的「Type something」：窗格正卡在卡上，/input 会一直排队。
// 只允许 agent 窗格；Herdr 只读降级时 503。
export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  let body: { text?: unknown; submit?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.text !== "string" || !body.text.trim()) {
    return Response.json({ error: "expected non-empty { text }" }, { status: 400 });
  }
  if (Buffer.byteLength(body.text, "utf8") > 8 * 1024) {
    return Response.json({ error: "text exceeds 8 KiB" }, { status: 413 });
  }
  // 卡内输入框是单行：连换行也拒，免得一个 \n 提前把答案交出去
  if (/[\u0000-\u001f\u007f]/.test(body.text)) {
    return Response.json({ error: "text contains control characters" }, { status: 400 });
  }
  if (body.submit !== undefined && typeof body.submit !== "boolean") {
    return Response.json({ error: "submit must be boolean" }, { status: 400 });
  }
  const { id } = await context.params;
  try {
    const service = getHerdrFleetService();
    await service.ensureStarted();
    const result = await service.text(id, body.text, body.submit !== false);
    return Response.json({ ok: true, result });
  } catch (error) {
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
