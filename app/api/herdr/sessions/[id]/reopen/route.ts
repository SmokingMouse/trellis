import { HerdrUnavailableError } from "@/lib/server/herdr-client";
import { getHerdrFleetService } from "@/lib/server/herdr-fleet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  try {
    const service = getHerdrFleetService();
    await service.ensureStarted();
    const paneId = await service.reopen(id);
    return Response.json({ ok: true, pane_id: paneId }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof HerdrUnavailableError ? 503 : message.includes("not found") ? 404 : 409;
    return Response.json({ error: message }, { status });
  }
}
