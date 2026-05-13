import { getNode } from "@/lib/server/repo";
import { subscribe } from "@/lib/server/run-bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Stage 17 reconnect endpoint. A tab woken up from background, a fresh
// page load with a streaming node, or a second device for the same
// session calls this to sync state. It always replies with SSE so the
// client can use the same handler shape as /api/chat.
//
// Two cases:
//   (a) run-bus has a live run → forward catchup + live events
//   (b) no live run → consult DB
//        - status='streaming' (process died mid-stream) → catchup +
//          synthesized error terminal + close
//        - status='done'/'error' → catchup + terminal from DB + close
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const node = getNode(id);
  if (!node) {
    return Response.json({ error: "node not found" }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Try the live bus first. Subscribe always delivers `catchup`
      // first; we forward it so the client can synchronize state. After
      // that, live deltas (if streaming) or the cached terminal event
      // (if just-finished) follow before the bus closes us out.
      const unsubscribe = subscribe(id, {
        onEvent: send,
        onClose: close,
      });
      if (unsubscribe) {
        const onAbort = () => {
          unsubscribe();
          close();
        };
        if (req.signal.aborted) {
          onAbort();
        } else {
          req.signal.addEventListener("abort", onAbort, { once: true });
        }
        return;
      }

      // No live run. The DB is authoritative — replay current state.
      // For status='streaming' in DB without a live run, the underlying
      // process died (server crash before reapInterruptedStreams ran,
      // or this run was orphaned). We surface that as an error so the
      // client can retry from a known state.
      const dbStatus = node.status;
      const catchupStatus: "streaming" | "done" | "error" =
        dbStatus === "done"
          ? "done"
          : dbStatus === "error"
            ? "error"
            : "error";
      send({
        type: "catchup",
        response: node.response,
        status: catchupStatus,
        toolCalls: node.toolCalls,
      });
      if (catchupStatus === "done") {
        send({ type: "done", usage: node.tokenCount });
      } else {
        send({
          type: "error",
          message: node.errorMessage ?? "stream ended",
        });
      }
      // Topic label may have arrived after the live run was reaped —
      // ship it so reconnect tabs render the label without a refresh.
      if (node.topicLabel) {
        send({
          type: "topic_label",
          nodeId: id,
          label: node.topicLabel,
        });
      }
      close();
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
