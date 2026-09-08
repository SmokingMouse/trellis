import {
  HerdrApiError,
  HerdrUnavailableError,
} from "@/lib/server/herdr-client";
import { getHerdrFleetService } from "@/lib/server/herdr-fleet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_MS = 1_000;
const cache = new Map<string, { at: number; text: string }>();
const pending = new Map<string, Promise<string>>();

function lastLines(text: string, count = 40): string {
  return text.replace(/\r/g, "").split("\n").slice(-count).join("\n");
}

async function cachedRead(paneId: string): Promise<string> {
  const cached = cache.get(paneId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.text;
  const running = pending.get(paneId);
  if (running) return running;
  const request = (async () => {
    const service = getHerdrFleetService();
    await service.ensureStarted();
    const result = await service.read(paneId);
    if (typeof result.read?.text !== "string") {
      throw new HerdrApiError("pane.read returned no read.text", "bad_response");
    }
    const text = lastLines(result.read.text);
    cache.set(paneId, { at: Date.now(), text });
    return text;
  })();
  pending.set(paneId, request);
  try {
    return await request;
  } finally {
    pending.delete(paneId);
  }
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  try {
    return Response.json(
      { ok: true, text: await cachedRead(id) },
      { headers: { "Cache-Control": "private, max-age=1" } },
    );
  } catch (error) {
    const status =
      error instanceof HerdrUnavailableError
        ? 503
        : error instanceof HerdrApiError && error.code === "pane_not_found"
          ? 404
          : 502;
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status },
    );
  }
}
