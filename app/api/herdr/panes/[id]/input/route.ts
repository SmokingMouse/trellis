import {
  HerdrApiError,
  HerdrUnavailableError,
} from "@/lib/server/herdr-client";
import { getHerdrFleetService } from "@/lib/server/herdr-fleet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  let body: { text?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.text !== "string" || !body.text.trim()) {
    return Response.json({ error: "expected non-empty { text }" }, { status: 400 });
  }
  if (Buffer.byteLength(body.text, "utf8") > 32 * 1024) {
    return Response.json({ error: "text exceeds 32 KiB" }, { status: 413 });
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.text)) {
    return Response.json({ error: "text contains terminal control characters" }, { status: 400 });
  }
  const { id } = await context.params;
  try {
    const service = getHerdrFleetService();
    await service.ensureStarted();
    const result = await service.input(id, body.text);
    return Response.json({ ok: true, status: result.status, result }, { status: result.status === "queued" ? 202 : 200 });
  } catch (error) {
    const status =
      error instanceof HerdrUnavailableError
        ? 503
        : error instanceof HerdrApiError && error.code === "queue_full"
          ? 429
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
