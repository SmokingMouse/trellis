import { getShadowClient } from "@/lib/server/as-client";
import { isShadowEnabled } from "@/lib/as-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Covered by the existing proxy.ts cookie gate, just like /api/chat.
export async function GET(request: Request) {
  if (!isShadowEnabled()) return Response.json({ error: "会话观察未启用" }, { status: 503 });
  try {
    const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
    return Response.json(await getShadowClient().listThreads(cursor), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "agent-server 暂不可用，请稍后重试" }, { status: 503 });
  }
}
