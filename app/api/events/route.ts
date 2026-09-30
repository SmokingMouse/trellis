import { subscribeCliSync } from "@/lib/server/cli-sync-events";
import { pendingSnapshot, schedulePendingRefresh } from "@/lib/server/pending";
import { subscribeTaskEvents } from "@/lib/server/task-events";
import { ensureConsoleHub } from "@/lib/server/console-hub";
import { formatSseFrame, type PageEventChannel } from "@/lib/sse-frames";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 页面级统一事件流：原来每个页面常驻 /api/cli-sync/events + /api/tasks/events 两条，
// Herdr 控制台再靠 2.5s 轮询（排队时还要第三条 /api/herdr/events）。HTTP/1.1 每源
// 只有 6 条连接、同源多标签页共享 —— 合成一条，按 SSE `event:` 字段多路复用：
//   event: cli    —— 原 /api/cli-sync/events 的 data（session_updated / pending_snapshot / sync_failed）
//   event: task   —— 原 /api/tasks/events 的 data（run_started / run_updated / run_finished）
//   event: herdr  —— 控制台失效通知 { type:"changed", fleetEtag, hooksEtag, kinds }
// 旧的两条路由保留给部署前打开的旧标签页，新前端不再连。
// 骨架（teardown / keepAlive / req.signal.abort）照抄 /api/cli-sync/events。
export async function GET(req: Request) {
  schedulePendingRefresh();
  const hub = ensureConsoleHub();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let keepAlive: ReturnType<typeof setInterval> | null = null;
      const unsubscribers: (() => void)[] = [];
      const teardown = () => {
        if (keepAlive) {
          clearInterval(keepAlive);
          keepAlive = null;
        }
        for (const off of unsubscribers.splice(0)) off();
      };
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
          teardown();
        }
      };
      const send = (channel: PageEventChannel, data: unknown) => write(formatSseFrame(channel, data));
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

      unsubscribers.push(
        subscribeCliSync({
          onEvent: event => send("cli", event.type === "pending_changed" ? { type: "pending_snapshot", ...pendingSnapshot() } : event),
          onClose: close,
        }),
        subscribeTaskEvents({ onEvent: event => send("task", event), onClose: close }),
        hub.subscribe(change => send("herdr", change)),
      );
      // 首帧：开流确认 + 当前快照。客户端据 herdr 首帧的 ETag 决定要不要立刻拉全量。
      send("cli", { type: "pending_snapshot", ...pendingSnapshot() });
      send("herdr", hub.current());
      keepAlive = setInterval(() => write(": ping\n\n"), 25_000);

      const onAbort = () => close();
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
