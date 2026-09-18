import { getNode, markNodeInterrupted } from "@/lib/server/repo";
import { subscribe } from "@/lib/server/run-bus";
import { isThreadNode, getProjectRun, projectSSE } from "@/lib/server/as-project";

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
  if (isThreadNode(id) && node.status === "streaming") {
    try {
      const run = await getProjectRun(id);
      if (run) return projectSSE(req, run);
    } catch (error) { return Response.json({ error: String(error) }, { status: 503 }); }
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
      // S176：不只是「对这次连接报个错」—— 把行也改对。否则每次刷新都要先转一圈
      // 再报错，而状态一直是 streaming（未读角标、pending 面板、上游对账全跟着错）。
      // 判据与开机 reap 同一套（markNodeInterrupted 内含 as_turns 排除），
      // 上面的 isThreadNode 分支已经把 AS 驱动的节点先接走了。
      if (dbStatus === "streaming") {
        try {
          markNodeInterrupted(id, node.errorMessage ?? "interrupted");
        } catch (err) {
          // 磁盘还满着就还是写不进去 —— 本次连接照样报错，行留给开机 reap。
          console.error(`[trellis] ${id} 收尸写入失败：`, err);
        }
      }
      send({
        type: "catchup",
        response: node.response,
        status: catchupStatus,
        toolCalls: node.toolCalls,
        // A路②: no live run means the process died — there's no resolver to
        // unpark, so a stale pending form would be un-answerable. Surface null
        // (the form, if any, is dead alongside the run). The live-bus path
        // above carries a real pending via subscribe()'s catchup.
        pendingInteraction: null,
      });
      if (catchupStatus === "done") {
        send({
          type: "done",
          usage: node.tokenCount,
          finalStart: node.finalStart ?? 0,
        });
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
