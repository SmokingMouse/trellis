// 页面级统一事件流的客户端：一个标签页只挂一条 /api/events，按 SSE `event:` 分发给
// cli（镜像同步）/ task（任务提醒）/ herdr（控制台失效通知）三类订阅者。
//
// 为什么不是各开各的：HTTP/1.1 每源 6 条连接、同源的所有标签页共用。原来每页常驻
// 两条（cli-sync + tasks），开三个标签页就占满，后续 fetch 全部排队 —— 合成一条后
// 同样三个标签页只占 3 条。多标签页仍是各自一条（跨标签共享要 SharedWorker/选主，
// 收益不值复杂度）。
//
// 手写 fetch + reader 而非 EventSource：能带 AbortSignal，pagehide 时干净收摊，
// 与原 useCliSyncEvents / TaskToast 同一套做法。
import { parseSseFrames, type PageEventChannel } from "./sse-frames";

export type PageEventStatus = {
  connected: boolean;
  /** connected=true 时：这是断线后的重连（订阅者应补拉一次全量）。 */
  reconnect: boolean;
};

type Handler = (data: unknown) => void;
type StatusHandler = (status: PageEventStatus) => void;

type Timer = unknown;

export type PageEventStreamOptions = {
  url?: string;
  fetch?: typeof fetch;
  schedule?: (fn: () => void, ms: number) => Timer;
  cancel?: (timer: Timer) => void;
  /** 第 n 次（从 1 起）连续失败后的重连间隔。 */
  retryMs?: (attempt: number) => number;
  /** 最后一个订阅者离开后多久断流（组件重挂载 / 路由切换时不抖连接）。 */
  idleCloseMs?: number;
};

export class PageEventStream {
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private controller: AbortController | null = null;
  private retryTimer: Timer | null = null;
  private idleTimer: Timer | null = null;
  private failures = 0;
  private everOpened = false;
  private paused = false;
  connected = false;

  constructor(private readonly options: PageEventStreamOptions = {}) {}

  private get refs(): number {
    let n = this.statusHandlers.size;
    for (const set of this.handlers.values()) n += set.size;
    return n;
  }

  on(channel: PageEventChannel, handler: Handler): () => void {
    let set = this.handlers.get(channel);
    if (!set) this.handlers.set(channel, (set = new Set()));
    set.add(handler);
    this.retain();
    return () => {
      set.delete(handler);
      this.release();
    };
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    this.retain();
    return () => {
      this.statusHandlers.delete(handler);
      this.release();
    };
  }

  /** pagehide：立刻断流并停止重连，直到 resume()。 */
  pause(): void {
    this.paused = true;
    this.stop();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.refs > 0) this.start();
  }

  private retain(): void {
    if (this.idleTimer !== null) {
      (this.options.cancel ?? clearTimeout)(this.idleTimer as ReturnType<typeof setTimeout>);
      this.idleTimer = null;
    }
    if (!this.paused && !this.controller && this.retryTimer === null) this.start();
  }

  private release(): void {
    if (this.refs > 0 || this.idleTimer !== null) return;
    this.idleTimer = (this.options.schedule ?? setTimeout)(() => {
      this.idleTimer = null;
      if (this.refs === 0) this.stop();
    }, this.options.idleCloseMs ?? 1_000);
  }

  private start(): void {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    void this.run(controller);
  }

  private stop(): void {
    if (this.retryTimer !== null) {
      (this.options.cancel ?? clearTimeout)(this.retryTimer as ReturnType<typeof setTimeout>);
      this.retryTimer = null;
    }
    const controller = this.controller;
    this.controller = null;
    controller?.abort();
    this.setDisconnected();
  }

  private setDisconnected(): void {
    if (!this.connected) return;
    this.connected = false;
    this.emitStatus({ connected: false, reconnect: false });
  }

  private emitStatus(status: PageEventStatus): void {
    for (const handler of [...this.statusHandlers]) {
      try { handler(status); } catch { /* 订阅者自己的错不拖垮流 */ }
    }
  }

  private dispatch(channel: string, data: string): void {
    const set = this.handlers.get(channel);
    if (!set?.size) return;
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { return; }
    for (const handler of [...set]) {
      try { handler(parsed); } catch { /* 同上 */ }
    }
  }

  private async run(controller: AbortController): Promise<void> {
    const signal = controller.signal;
    try {
      const res = await (this.options.fetch ?? fetch)(this.options.url ?? "/api/events", {
        signal,
        cache: "no-store",
        headers: { Accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) throw new Error(`events HTTP ${res.status}`);
      const reconnect = this.everOpened;
      this.everOpened = true;
      this.failures = 0;
      this.connected = true;
      this.emitStatus({ connected: true, reconnect });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseFrames(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) this.dispatch(frame.event, frame.data);
      }
    } catch {
      /* 断流 / 网络错 / 401 —— 下面按退避重连 */
    }
    if (this.controller !== controller) return; // 已被 stop() 接管
    this.controller = null;
    this.setDisconnected();
    if (this.paused || this.refs === 0) return;
    this.failures++;
    const delay = this.options.retryMs?.(this.failures) ?? Math.min(2_000 * this.failures, 10_000);
    this.retryTimer = (this.options.schedule ?? setTimeout)(() => {
      this.retryTimer = null;
      if (!this.paused && this.refs > 0) this.start();
    }, delay);
  }
}

let shared: PageEventStream | null = null;

/** 浏览器里的单例；首次取用时挂 pagehide / pageshow（bfcache 不卸载 React 树）。 */
export function pageEvents(): PageEventStream {
  if (shared) return shared;
  const stream = new PageEventStream();
  shared = stream;
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => stream.pause());
    window.addEventListener("pageshow", (event) => {
      if ((event as PageTransitionEvent).persisted) stream.resume();
    });
  }
  return stream;
}
