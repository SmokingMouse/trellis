import {
  HerdrApiError,
  HerdrUnavailableError,
} from "@/lib/server/herdr-client";
import { getHerdrFleetService } from "@/lib/server/herdr-fleet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_MS = 1_000;
const MAX_LINES = 1000;
const cache = new Map<string, { at: number; text: string }>();
const pending = new Map<string, Promise<string>>();

function lastLines(text: string, count: number): string {
  return text.replace(/\r/g, "").split("\n").slice(-count).join("\n");
}

// 缓存整屏（最多 1000 行），按请求切尾：会话卡读 40 行、悬停预览读几行、终端抽屉读 1000 行
// 共用同一份，1 秒内的并发读只打一次 socket。
async function cachedRead(
  paneId: string,
  fetchLines = 200,
  format: "text" | "ansi" = "text",
): Promise<string> {
  const cacheKey = `${paneId}:${format}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.text;
  const running = pending.get(cacheKey);
  if (running) return running;
  const request = (async () => {
    const service = getHerdrFleetService();
    await service.ensureStarted();
    const result = await service.read(paneId, fetchLines, format);
    if (typeof result.read?.text !== "string") {
      throw new HerdrApiError("pane.read returned no read.text", "bad_response");
    }
    const text = lastLines(result.read.text, MAX_LINES);
    cache.set(cacheKey, { at: Date.now(), text });
    return text;
  })();
  pending.set(cacheKey, request);
  try {
    return await request;
  } finally {
    pending.delete(cacheKey);
  }
}

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const url = new URL(req.url);
  const requested = Number(url.searchParams.get("lines") ?? 40);
  const format = url.searchParams.get("format") === "ansi" ? "ansi" : "text";
  const lines = Number.isFinite(requested) ? Math.min(MAX_LINES, Math.max(1, Math.floor(requested))) : 40;
  const fetchLines = lines > 200 ? lines : 200;
  try {
    return Response.json(
      { ok: true, text: lastLines(await cachedRead(id, fetchLines, format), lines) },
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
