import { ShadowClient } from "@/lib/server/as-client";
import { isShadowEnabled } from "@/lib/as-config";
import type { ShadowEvent } from "@/lib/as-shadow";
import { ErrorCode, ProtocolError } from "@smokingmouse/agent-server/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isShadowEnabled()) return Response.json({ error: "会话观察未启用" }, { status: 503 });
  const { id } = await context.params;
  // EventSource's Last-Event-ID takes precedence over its original URL cursor.
  const raw = request.headers.get("last-event-id") || new URL(request.url).searchParams.get("sinceSeq") || "0";
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    return Response.json({ error: "sinceSeq 必须为非负安全整数" }, { status: 400 });
  }
  const observer = new ShadowClient();
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    observer.close();
    request.signal.removeEventListener("abort", close);
    try { controller?.close(); } catch { /* ReadableStream.cancel already closed it. */ }
  };
  const send = (data: string) => {
    if (closed) return;
    // A slow browser must not retain unbounded daemon output on the server.
    if ((controller.desiredSize ?? 0) <= 0) { close(); return; }
    controller.enqueue(encoder.encode(data));
  };
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; }, cancel() { close(); },
  }, { highWaterMark: 1024 * 1024, size: chunk => chunk?.byteLength ?? 0 });
  observer.onEvent((event: ShadowEvent) => {
    const seq = event.type === "snapshot" ? event.snapshot.nextSeq - 1
      : event.type === "notification" && "seq" in event.notification.params ? event.notification.params.seq : undefined;
    send(`${seq === undefined ? "" : `id: ${seq}\n`}data: ${JSON.stringify(event)}\n\n`);
  });
  request.signal.addEventListener("abort", close, { once: true });
  if (request.signal.aborted) close();
  try {
    await observer.attach(id, Number(raw));
    if (!closed) heartbeat = setInterval(() => send(": heartbeat\n\n"), 15000);
    return new Response(stream, { headers: {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive", "X-Accel-Buffering": "no",
    } });
  } catch (error) {
    close();
    const status = error instanceof ProtocolError && error.code === ErrorCode.thread_not_found ? 404 : 503;
    return Response.json({ error: status === 404 ? "thread 不存在" : "agent-server 暂不可用" }, { status });
  }
}
