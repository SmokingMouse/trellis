import { getNode } from "@/lib/server/repo";
import { daemonIdentity, resolveSessionBinding } from "@/lib/server/session-binding";
import { projectTarget } from "@/lib/server/as-project";
import { ThreadObserver } from "@/lib/server/as-client";
import { isAgentServerEnabled } from "@/lib/as-config";
import { createThreadSseBuffer } from "@/lib/server/as-thread-sse";
import type { ThreadEvent } from "@/lib/as-thread-event";
import { ErrorCode, ProtocolError } from "@smokingmouse/agent-server/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isAgentServerEnabled()) return Response.json({ error: "Agent 服务未启用" }, { status: 503 });
  const { id } = await context.params;
  const node = getNode(id);
  if (!node) return Response.json({ error: "node not found" }, { status: 404 });
  const target = projectTarget(id);
  if (resolveSessionBinding(node.sessionId).type !== "thread" || !target || target.daemon_id !== daemonIdentity()) {
    return Response.json({ error: "node has no binding to this daemon" }, { status: 404 });
  }
  // EventSource's Last-Event-ID takes precedence over its original URL cursor.
  const raw = request.headers.get("last-event-id") || new URL(request.url).searchParams.get("sinceSeq") || "0";
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    return Response.json({ error: "sinceSeq 必须为非负安全整数" }, { status: 400 });
  }
  const observer = new ThreadObserver();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    observer.close();
    request.signal.removeEventListener("abort", close);
    buffer.close();
  };
  const buffer = createThreadSseBuffer(close);
  const { stream, send } = buffer;
  let initialSnapshot = true;
  observer.onEvent((event: ThreadEvent) => {
    const seq = event.type === "snapshot" ? event.snapshot.nextSeq - 1
      : event.type === "notification" && "seq" in event.notification.params ? event.notification.params.seq : undefined;
    const bootstrap = event.type === "snapshot" && initialSnapshot;
    if (bootstrap) initialSnapshot = false;
    send(`${seq === undefined ? "" : `id: ${seq}\n`}data: ${JSON.stringify(event)}\n\n`, bootstrap);
  });
  request.signal.addEventListener("abort", close, { once: true });
  if (request.signal.aborted) close();
  try {
    await observer.attach(target.thread_id, Number(raw));
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
