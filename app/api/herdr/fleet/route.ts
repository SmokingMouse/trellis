import { getHerdrFleetService } from "@/lib/server/herdr-fleet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const service = getHerdrFleetService();
  await service.ensureStarted();
  const etag = service.etag();
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": "no-store" },
    });
  }
  return Response.json(service.fleet(), {
    headers: { ETag: etag, "Cache-Control": "no-store" },
  });
}
