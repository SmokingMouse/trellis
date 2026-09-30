import { describe, expect, test } from "bun:test";
import { PageEventStream, type PageEventStatus } from "./page-events";
import { formatSseFrame } from "./sse-frames";

type Conn = { push: (text: string) => void; end: () => void; signal: AbortSignal };

function harness() {
  const conns: Conn[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const encoder = new TextEncoder();
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const signal = init!.signal!;
    signal.addEventListener("abort", () => { try { controller.error(new Error("aborted")); } catch { /* closed */ } });
    conns.push({
      push: (text) => controller.enqueue(encoder.encode(text)),
      end: () => controller.close(),
      signal,
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  const stream = new PageEventStream({
    fetch: fakeFetch,
    schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return t; },
    cancel: (t) => { (t as { cancelled: boolean }).cancelled = true; },
    retryMs: () => 50,
    idleCloseMs: 10,
  });
  const runTimers = () => { for (const t of timers.splice(0)) if (!t.cancelled) t.fn(); };
  return { stream, conns, timers, runTimers };
}

const tick = () => new Promise(r => setTimeout(r, 5));

describe("PageEventStream 多路复用", () => {
  test("多个订阅者共用一条连接，按 event 分发到各自通道", async () => {
    const h = harness();
    const got: Record<string, unknown[]> = { cli: [], task: [], herdr: [] };
    h.stream.on("cli", d => got.cli.push(d));
    h.stream.on("task", d => got.task.push(d));
    h.stream.on("herdr", d => got.herdr.push(d));
    await tick();
    expect(h.conns).toHaveLength(1);
    h.conns[0].push(formatSseFrame("herdr", { type: "changed", fleetEtag: "a" }) + ": ping\n\n" + formatSseFrame("task", { type: "run_started" }));
    h.conns[0].push(formatSseFrame("cli", { type: "session_updated", sessionId: "s" }).slice(0, 12));
    await tick();
    expect(got.herdr).toEqual([{ type: "changed", fleetEtag: "a" }]);
    expect(got.task).toEqual([{ type: "run_started" }]);
    expect(got.cli).toEqual([]);
    h.conns[0].push(formatSseFrame("cli", { type: "session_updated", sessionId: "s" }).slice(12));
    await tick();
    expect(got.cli).toEqual([{ type: "session_updated", sessionId: "s" }]);
  });

  test("断流 → 通知断线 → 退避重连 → 重连成功标记 reconnect（订阅者据此补拉全量）", async () => {
    const h = harness();
    const statuses: PageEventStatus[] = [];
    h.stream.onStatus(s => statuses.push(s));
    await tick();
    expect(statuses).toEqual([{ connected: true, reconnect: false }]);
    h.conns[0].end();
    await tick();
    expect(statuses.at(-1)).toEqual({ connected: false, reconnect: false });
    expect(h.stream.connected).toBe(false);
    expect(h.timers.filter(t => !t.cancelled).map(t => t.ms)).toEqual([50]);
    h.runTimers();
    await tick();
    expect(h.conns).toHaveLength(2);
    expect(statuses.at(-1)).toEqual({ connected: true, reconnect: true });
  });

  test("最后一个订阅者离开后经空闲宽限断流；宽限内重新订阅不抖连接", async () => {
    const h = harness();
    const off = h.stream.on("cli", () => {});
    await tick();
    off();
    h.stream.on("task", () => {});
    h.runTimers(); // 宽限定时器已被取消
    expect(h.conns[0].signal.aborted).toBe(false);
    const h2 = harness();
    const off2 = h2.stream.on("cli", () => {});
    await tick();
    off2();
    h2.runTimers();
    expect(h2.conns[0].signal.aborted).toBe(true);
  });

  test("pagehide 暂停：断流且不重连；pageshow 恢复即重连", async () => {
    const h = harness();
    h.stream.on("herdr", () => {});
    await tick();
    h.stream.pause();
    await tick();
    expect(h.conns[0].signal.aborted).toBe(true);
    expect(h.timers.filter(t => !t.cancelled && t.ms === 50)).toHaveLength(0);
    h.stream.resume();
    await tick();
    expect(h.conns).toHaveLength(2);
  });
});
