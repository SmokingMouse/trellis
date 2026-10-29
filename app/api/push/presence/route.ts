import { reportPresence } from "@/lib/server/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/push/presence { clientId, sessionId, visible }：页面心跳（hooks/usePushBridge）。
// 某会话在任一页面前台可见时，它的「完成 / 等你回答」不推手机。只进内存，不落库。
// 页面隐藏时用 sendBeacon 发（content-type 是 text/plain），所以按文本读再 parse。
export async function POST(req: Request) {
  let body: { clientId?: unknown; sessionId?: unknown; visible?: unknown };
  try {
    body = JSON.parse(await req.text());
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const clientId = typeof body.clientId === "string" ? body.clientId.slice(0, 64) : "";
  if (!clientId) return Response.json({ error: "clientId required" }, { status: 400 });
  const sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId.slice(0, 128) : null;
  reportPresence(clientId, sessionId, body.visible === true);
  return new Response(null, { status: 204 });
}
