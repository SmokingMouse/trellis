// /api/chat 的发送幂等（自起会话）：请求体带 clientMsgId 时，TTL 内同一个 id 只起一轮。
// 重复请求（Outbox 重发、响应丢了重试）不再建节点、不再 spawn，而是回第一次的结果：
// 同一个 `created` 事件 + 该节点的重连流（GET /api/nodes/:id/stream 的 catchup + 后续事件）。
//
// 收敛成 withChatIdempotency 包一层 + noteChatCreated 一行登记，route.ts 本体几乎不动。
import { IdempotencyCache, isClientMsgId } from "./idempotency";

export type ChatSendRecord = { nodeId: string; createdEvent: Record<string, unknown> };

const sends = new IdempotencyCache<ChatSendRecord | null>();
// 本次请求建出的节点（route 里起跑后登记）；WeakMap 跟着 Request 走，不用手动清
const createdByRequest = new WeakMap<Request, ChatSendRecord>();

/** route 在 startRun 之后、回 SSE 之前调：记下这次请求建出的节点和 created 事件。 */
export function noteChatCreated(req: Request, nodeId: string, createdEvent: Record<string, unknown>): void {
  createdByRequest.set(req, { nodeId, createdEvent });
}

async function peekClientMsgId(req: Request): Promise<string | null> {
  try {
    const body = (await req.clone().json()) as { clientMsgId?: unknown } | null;
    return body && isClientMsgId(body.clientMsgId) ? body.clientMsgId : null;
  } catch {
    return null;
  }
}

/** 重复请求的回复：先补 created，再接上该节点的重连流。 */
export async function replayChatSend(req: Request, record: ChatSendRecord): Promise<Response> {
  const { GET } = await import("@/app/api/nodes/[id]/stream/route");
  const inner = await GET(new Request(new URL(`/api/nodes/${record.nodeId}/stream`, req.url), { signal: req.signal }), {
    params: Promise.resolve({ id: record.nodeId }),
  });
  const encoder = new TextEncoder();
  const head = encoder.encode(`data: ${JSON.stringify({ ...record.createdEvent, duplicate: true })}\n\n`);
  const body = inner.ok && inner.body ? inner.body : null;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(head);
      if (!body) {
        controller.close();
        return;
      }
      const reader = body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      void body?.cancel().catch(() => {});
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

/**
 * 包住 POST /api/chat：没带 clientMsgId 原样处理；带了就按 id 去重。
 * 第一次没建出节点（4xx / 5xx / 抛错）就忘掉这个 id，重发会真的再试一次。
 */
export async function withChatIdempotency(
  req: Request,
  handle: (req: Request) => Promise<Response>,
  replay: (req: Request, record: ChatSendRecord) => Promise<Response> = replayChatSend,
): Promise<Response> {
  const clientMsgId = await peekClientMsgId(req);
  if (!clientMsgId) return handle(req);
  const existing = sends.peek(clientMsgId);
  if (existing) {
    const record = await existing.catch(() => null);
    if (record) return replay(req, record);
  }
  let settle: (record: ChatSendRecord | null) => void = () => {};
  const pending = new Promise<ChatSendRecord | null>((resolve) => {
    settle = resolve;
  });
  sends.set(clientMsgId, pending);
  try {
    const response = await handle(req);
    const record = response.ok ? createdByRequest.get(req) ?? null : null;
    settle(record);
    if (!record) sends.delete(clientMsgId);
    return response;
  } catch (error) {
    settle(null);
    sends.delete(clientMsgId);
    throw error;
  }
}

/** 测试用：清空去重表。 */
export function resetChatIdempotency(): void {
  sends.clear();
}
