import { parseSubscription } from "@/lib/push";
import {
  countSubscriptions,
  deleteSubscription,
  hasSubscription,
  saveSubscription,
} from "@/lib/server/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/push/subscribe?endpoint=… → { known, total }：服务端认不认这个浏览器的订阅。
export async function GET(req: Request) {
  const endpoint = new URL(req.url).searchParams.get("endpoint") ?? "";
  return Response.json({ known: endpoint ? hasSubscription(endpoint) : false, total: countSubscriptions() });
}

// POST /api/push/subscribe { subscription: PushSubscription.toJSON() }
export async function POST(req: Request) {
  let body: { subscription?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const sub = parseSubscription(body.subscription);
  if (!sub) return Response.json({ error: "invalid subscription" }, { status: 400 });
  saveSubscription(sub, req.headers.get("user-agent"));
  return Response.json({ ok: true, total: countSubscriptions() });
}

// DELETE /api/push/subscribe { endpoint }
export async function DELETE(req: Request) {
  let body: { endpoint?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (typeof body.endpoint !== "string" || !body.endpoint) {
    return Response.json({ error: "endpoint required" }, { status: 400 });
  }
  const removed = deleteSubscription(body.endpoint);
  return Response.json({ ok: true, removed, total: countSubscriptions() });
}
