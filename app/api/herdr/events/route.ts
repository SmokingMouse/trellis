import { getHerdrFleetService } from "@/lib/server/herdr-fleet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const service = getHerdrFleetService();
  await service.ensureStarted();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const publish = () => {
        if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(service.fleet())}\n\n`));
      };
      const unsubscribe = service.client.subscribe(publish);
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }, 15_000);
      const abort = () => { cleanup(); controller.close(); };
      cleanup = () => {
        closed = true;
        unsubscribe();
        clearInterval(heartbeat);
        req.signal.removeEventListener("abort", abort);
      };
      req.signal.addEventListener("abort", abort, { once: true });
      if (req.signal.aborted) abort();
      else publish();
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  } });
}
