import { getShadowClient } from "@/lib/server/as-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Covered by the existing proxy.ts cookie gate, just like /api/chat.
export async function GET(request: Request) {
  try {
    const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
    return Response.json(await getShadowClient().listThreads(cursor), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "agent-server 暂不可用，请稍后重试" }, { status: 503 });
  }
}
