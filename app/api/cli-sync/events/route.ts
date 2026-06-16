import { subscribeCliSync } from "@/lib/server/cli-sync-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let keepAlive: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: (() => void) | null = null;
      const teardown = () => {
        if (keepAlive) {
          clearInterval(keepAlive);
          keepAlive = null;
        }
        unsubscribe?.();
        unsubscribe = null;
      };
      const send = (event: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          closed = true;
          teardown();
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        teardown();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      unsubscribe = subscribeCliSync({
        onEvent: send,
        onClose: close,
      });
      send({ type: "ping" });
      keepAlive = setInterval(() => send({ type: "ping" }), 30_000);

      const onAbort = () => {
        close();
      };
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener("abort", onAbort, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
