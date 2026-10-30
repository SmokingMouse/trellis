import { activeRound, getGroup, subscribeGroup } from "@/lib/server/groups";
import type { GroupEvent } from "@/lib/groups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 20_000;

/**
 * 群聊的实时通道（SSE）：先发一次当前轮次快照，之后推
 *   { type:"round", round }  轮次状态（谁在想、第几遍、几条、结束原因）
 *   { type:"node", node }    新出现的群消息 / 上限卡（流式内容另走 /api/nodes/[id]/stream）
 * 断开只是少一个订阅者，不影响服务端这一轮。
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!getGroup(id)) return Response.json({ error: "group not found" }, { status: 404 });
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (e: GroupEvent | { type: "ping" }) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          closed = true;
        }
      };
      send({ type: "round", round: activeRound(id) });
      const unsub = subscribeGroup(id, send);
      const timer = setInterval(() => send({ type: "ping" }), HEARTBEAT_MS);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        unsub();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      if (req.signal.aborted) cleanup();
      else req.signal.addEventListener("abort", () => cleanup(), { once: true });
    },
    cancel() {
      cleanup();
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
