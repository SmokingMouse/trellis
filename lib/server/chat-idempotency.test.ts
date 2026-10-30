import { afterEach, describe, expect, test } from "bun:test";
import { noteChatCreated, resetChatIdempotency, withChatIdempotency, type ChatSendRecord } from "./chat-idempotency";

const post = (body: unknown) =>
  new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify(body) });

afterEach(() => resetChatIdempotency());

/** 假 handler：每次调用建一个新节点（登记 created），回 200 SSE。 */
function fakeHandler(status = 200) {
  const calls: string[] = [];
  const handle = async (req: Request) => {
    const body = (await req.json()) as { question: string };
    calls.push(body.question);
    const nodeId = `n${calls.length}`;
    if (status === 200) noteChatCreated(req, nodeId, { type: "created", node: { id: nodeId } });
    return new Response(status === 200 ? "data: {}\n\n" : JSON.stringify({ error: "nope" }), { status });
  };
  return { calls, handle };
}

const replays: ChatSendRecord[] = [];
const replay = async (_req: Request, record: ChatSendRecord) => {
  replays.push(record);
  return new Response(`replay:${record.nodeId}`);
};

describe("withChatIdempotency", () => {
  test("不带 clientMsgId：每次都照常处理", async () => {
    const { calls, handle } = fakeHandler();
    await withChatIdempotency(post({ question: "q" }), handle, replay);
    await withChatIdempotency(post({ question: "q" }), handle, replay);
    expect(calls).toEqual(["q", "q"]);
  });

  test("同一个 clientMsgId 重发：不再起一轮，回第一次的节点", async () => {
    replays.length = 0;
    const { calls, handle } = fakeHandler();
    const first = await withChatIdempotency(post({ question: "q", clientMsgId: "m-1" }), handle, replay);
    expect(first.status).toBe(200);
    const second = await withChatIdempotency(post({ question: "q", clientMsgId: "m-1" }), handle, replay);
    expect(await second.text()).toBe("replay:n1");
    expect(calls).toEqual(["q"]);
    expect(replays[0]).toEqual({ nodeId: "n1", createdEvent: { type: "created", node: { id: "n1" } } });
  });

  test("并发的两个重复请求只起一轮", async () => {
    const { calls, handle } = fakeHandler();
    const [a, b] = await Promise.all([
      withChatIdempotency(post({ question: "q", clientMsgId: "m-2" }), handle, replay),
      withChatIdempotency(post({ question: "q", clientMsgId: "m-2" }), handle, replay),
    ]);
    expect(calls).toHaveLength(1);
    expect([a.status, b.status]).toEqual([200, 200]);
  });

  test("第一次没建出节点（4xx / 5xx）→ 忘掉 id，重发真的再试", async () => {
    const failing = fakeHandler(503);
    const res = await withChatIdempotency(post({ question: "q", clientMsgId: "m-3" }), failing.handle, replay);
    expect(res.status).toBe(503);
    const ok = fakeHandler();
    await withChatIdempotency(post({ question: "q", clientMsgId: "m-3" }), ok.handle, replay);
    expect(ok.calls).toEqual(["q"]);
  });

  test("handler 抛错 → 忘掉 id", async () => {
    await expect(
      withChatIdempotency(post({ question: "q", clientMsgId: "m-4" }), async () => { throw new Error("boom"); }, replay),
    ).rejects.toThrow("boom");
    const ok = fakeHandler();
    await withChatIdempotency(post({ question: "q", clientMsgId: "m-4" }), ok.handle, replay);
    expect(ok.calls).toHaveLength(1);
  });

  test("非法 clientMsgId 当没带", async () => {
    const { calls, handle } = fakeHandler();
    await withChatIdempotency(post({ question: "q", clientMsgId: "has space" }), handle, replay);
    await withChatIdempotency(post({ question: "q", clientMsgId: "has space" }), handle, replay);
    expect(calls).toHaveLength(2);
  });
});
