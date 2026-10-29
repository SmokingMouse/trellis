import { describe, expect, it } from "bun:test";
import {
  EMPTY_QUEUE,
  editQueued,
  enqueue,
  isBusySendMode,
  newQueuedMessage,
  observeQueue,
  parseQueue,
  queueStatus,
  removeQueued,
  requeueFailed,
  resumeQueue,
  serializeQueue,
  type ComposerQueue,
  type QueueTarget,
} from "./composer-queue";

const msg = (text: string) => ({ ...newQueuedMessage(text, [], 0), id: `m-${text}` });
const node = (id: string, status: QueueTarget["status"], parentId: string | null = "p", optimistic = false): QueueTarget => ({
  id,
  parentId,
  status,
  optimistic,
});
const HASH = "a".repeat(64);

/** 依次喂目标，收集发出的 (文本 → 父节点)。 */
function drive(q: ComposerQueue, targets: (QueueTarget | null)[]) {
  const sent: string[] = [];
  for (const t of targets) {
    const step = observeQueue(q, t);
    q = step.queue;
    if (step.action) sent.push(`${step.action.item.text}→${step.action.targetId}`);
  }
  return { q, sent };
}

describe("enqueue / observeQueue", () => {
  it("drains in order after each turn completes, following the new child", () => {
    let q = enqueue(EMPTY_QUEUE, msg("a"), node("n1", "streaming"));
    q = enqueue(q, msg("b"), node("n1", "streaming"));
    expect(q.follow).toEqual({ kind: "node", nodeId: "n1" });
    const { q: end, sent } = drive(q, [
      node("n1", "streaming"),
      node("n1", "done"), // → 发 a
      node("n1", "done"), // 同一目标再看一次（StrictMode 双跑）不重复
      node("opt-1", "streaming", "n1", true), // 乐观占位忽略
      node("n2", "streaming", "n1"), // 真实子节点接管跟随
      node("n2", "done"), // → 发 b
    ]);
    expect(sent).toEqual(["a→n1", "b→n2"]);
    expect(end).toEqual(EMPTY_QUEUE);
  });

  it("chains through a child that finished before its streaming frame was seen", () => {
    let q = enqueue(EMPTY_QUEUE, msg("a"), node("n1", "streaming"));
    q = enqueue(q, msg("b"), node("n1", "streaming"));
    const { sent } = drive(q, [node("n1", "done"), node("n2", "done", "n1")]);
    expect(sent).toEqual(["a→n1", "b→n2"]);
  });

  it("queued while the turn is still optimistic follows the parent's child", () => {
    const q = enqueue(EMPTY_QUEUE, msg("a"), node("opt", "streaming", "n0", true));
    expect(q.follow).toEqual({ kind: "childOf", parentId: "n0" });
    expect(drive(q, [node("n1", "streaming", "n0"), node("n1", "done", "n0")]).sent).toEqual(["a→n1"]);
  });

  it("pauses on error / abort and never auto-sends; resume sends the head", () => {
    const q0 = enqueue(EMPTY_QUEUE, msg("a"), node("n1", "streaming"));
    const { q, sent } = drive(q0, [node("n1", "error"), node("n1", "error")]);
    expect(sent).toEqual([]);
    expect(q.paused).toBe(true);
    expect(queueStatus(q, node("n1", "error"))).toBe("paused");
    const resumed = resumeQueue(q, node("n1", "error"));
    expect(resumed.action?.item.text).toBe("a");
    expect(resumed.action?.targetId).toBe("n1");
    expect(resumed.queue).toEqual(EMPTY_QUEUE);
  });

  it("a new real stream (e.g. a manual send while paused) un-pauses and takes over", () => {
    const paused: ComposerQueue = { items: [msg("a")], follow: { kind: "node", nodeId: "n1" }, paused: true };
    const { q, sent } = drive(paused, [node("n2", "streaming", "n1"), node("n2", "done", "n1")]);
    expect(sent).toEqual(["a→n2"]);
    expect(q).toEqual(EMPTY_QUEUE);
  });

  it("does not send when the idle target is not the node the queue waits for", () => {
    const q = enqueue(EMPTY_QUEUE, msg("a"), node("n1", "streaming"));
    const step = observeQueue(q, node("other", "done"));
    expect(step.action).toBeNull();
    expect(queueStatus(step.queue, node("other", "done"))).toBe("waiting");
    expect(queueStatus(step.queue, node("n1", "streaming"))).toBe("auto");
  });

  it("resume while the target still streams only re-arms auto-send", () => {
    const paused: ComposerQueue = { items: [msg("a")], follow: { kind: "node", nodeId: "n0" }, paused: true };
    const step = resumeQueue(paused, node("n1", "streaming"));
    expect(step.action).toBeNull();
    expect(step.queue).toEqual({ items: paused.items, follow: { kind: "node", nodeId: "n1" }, paused: false });
  });

  it("empty queue normalizes stale follow / paused and never acts", () => {
    const stale: ComposerQueue = { items: [], follow: { kind: "node", nodeId: "x" }, paused: true };
    expect(observeQueue(stale, node("x", "done"))).toEqual({ queue: EMPTY_QUEUE, action: null });
    expect(observeQueue(EMPTY_QUEUE, node("x", "done")).queue).toBe(EMPTY_QUEUE);
  });

  it("an enqueue onto an already-finished target sends on the next observe", () => {
    // 插话被拒（这一轮刚结束）→ 回退入队：目标已 done，commitQueue 立刻 observe。
    const q = enqueue(EMPTY_QUEUE, msg("late"), node("n1", "done"));
    expect(observeQueue(q, node("n1", "done")).action?.item.text).toBe("late");
  });
});

describe("edit / remove / requeue", () => {
  it("edits in place, ignores blank edits", () => {
    const q = enqueue(EMPTY_QUEUE, msg("a"), node("n1", "streaming"));
    expect(editQueued(q, "m-a", "  changed  ").items[0].text).toBe("changed");
    expect(editQueued(q, "m-a", "   ")).toBe(q);
  });

  it("remove returns the item for refilling and empties cleanly", () => {
    let q = enqueue(EMPTY_QUEUE, msg("a"), node("n1", "streaming"));
    q = enqueue(q, msg("b"), node("n1", "streaming"));
    const first = removeQueued(q, "m-a");
    expect(first.removed?.text).toBe("a");
    expect(first.queue.items.map((i) => i.text)).toEqual(["b"]);
    expect(first.queue.follow).toEqual(q.follow);
    expect(removeQueued(first.queue, "m-b").queue).toEqual(EMPTY_QUEUE);
    expect(removeQueued(q, "missing")).toEqual({ queue: q, removed: null });
  });

  it("a dispatch that never landed goes back to the head, paused", () => {
    const rest: ComposerQueue = { items: [msg("b")], follow: { kind: "childOf", parentId: "n1" }, paused: false };
    const q = requeueFailed(rest, msg("a"), "n1");
    expect(q.items.map((i) => i.text)).toEqual(["a", "b"]);
    expect(q).toMatchObject({ follow: { kind: "node", nodeId: "n1" }, paused: true });
    expect(requeueFailed(q, msg("a"), "n1")).toBe(q);
  });
});

describe("persistence", () => {
  it("round-trips items, attachments, follow and paused", () => {
    const q: ComposerQueue = {
      items: [{ ...msg("a"), attachments: [{ hash: HASH, mime: "image/png", size: 3, filename: null, width: 2 }] }],
      follow: { kind: "childOf", parentId: null },
      paused: true,
    };
    expect(parseQueue(serializeQueue(q))).toEqual(q);
    expect(serializeQueue(EMPTY_QUEUE)).toBeNull();
  });

  it("drops malformed data instead of throwing", () => {
    expect(parseQueue(null)).toEqual(EMPTY_QUEUE);
    expect(parseQueue("{not json")).toEqual(EMPTY_QUEUE);
    expect(parseQueue(JSON.stringify({ items: [{ id: 1 }, { id: "x", text: "  " }] }))).toEqual(EMPTY_QUEUE);
    const parsed = parseQueue(
      JSON.stringify({
        items: [{ id: "x", text: "hi", attachments: [{ hash: "nope", mime: "image/png", size: 1 }] }],
        follow: { kind: "bogus" },
      }),
    );
    expect(parsed).toEqual({ items: [{ id: "x", text: "hi", attachments: [], createdAt: 0 }], follow: null, paused: false });
  });
});

describe("isBusySendMode", () => {
  it("accepts only the two modes", () => {
    expect(isBusySendMode("queue")).toBe(true);
    expect(isBusySendMode("steer")).toBe(true);
    expect(isBusySendMode("interrupt")).toBe(false);
    expect(isBusySendMode(null)).toBe(false);
  });
});
