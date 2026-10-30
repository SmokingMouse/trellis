// 浏览器侧的 /herdr-stream 连接：重连退避、登录态探测、页面隐藏时暂停、心跳。
// 和 xterm 无关的部分都在这里，组件只管渲染（components/herdr/HerdrLiveTerminal）。

import {
  CLOSE_PANE_GONE,
  CLOSE_UNSUPPORTED,
  HERDR_STREAM_PATH,
  type HerdrStreamClientMessage,
  type HerdrStreamServerMessage,
} from "./herdr-stream-protocol";
import { FALLBACK_AFTER_FAILURES, reconnectDelayMs } from "./herdr-term-keys";

export type HerdrStreamStatus =
  /** 第一次连接中 */
  | "connecting"
  | "live"
  /** 断了，正在退避重连（或页面隐藏暂停中） */
  | "reconnecting"
  /** 不再重连：窗格关了 / 登录失效 */
  | "offline"
  /** 实时流不可用（herdr 太旧、反复连不上）：调用方应回退轮询 */
  | "unsupported";

export type HerdrStreamHandlers = {
  onStatus(status: HerdrStreamStatus, detail?: string): void;
  onBytes(bytes: Uint8Array): void;
  onMessage(msg: HerdrStreamServerMessage): void;
};

/** 心跳：cloudflared / hub 网关对空闲 WS 有超时，安静的窗格也要定期说句话。 */
const PING_MS = 25_000;

export class HerdrStreamClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private paused = false;
  /** 自上次 ready 以来连续失败的次数（决定退避档位和是否回退轮询）。 */
  private failures = 0;
  private everReady = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onVisibility = () => this.syncVisibility();

  constructor(
    private readonly paneId: string,
    private readonly hint: () => { cols: number; rows: number } | null,
    private readonly h: HerdrStreamHandlers,
  ) {}

  start(): void {
    document.addEventListener("visibilitychange", this.onVisibility);
    if (document.visibilityState === "hidden") {
      this.paused = true;
      this.h.onStatus("reconnecting", "页面在后台，已暂停");
      return;
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.teardown();
  }

  send(msg: HerdrStreamClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // 页面隐藏就断开（省流量、省大门的 observe 子进程），回来立即重连——重连的第一帧
  // 是整屏，不用补任何东西。
  private syncVisibility(): void {
    if (this.stopped) return;
    if (document.visibilityState === "hidden") {
      if (this.paused) return;
      this.paused = true;
      this.teardown();
      this.h.onStatus("reconnecting", "页面在后台，已暂停");
    } else if (this.paused) {
      this.paused = false;
      this.failures = 0;
      this.connect();
    }
  }

  private teardown(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      try {
        ws.close(1000);
      } catch {
        /* 已经关了 */
      }
    }
  }

  private url(): string {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const q = new URLSearchParams({ pane: this.paneId });
    const hint = this.hint();
    if (hint) {
      q.set("cols", String(hint.cols));
      q.set("rows", String(hint.rows));
    }
    return `${proto}//${location.host}${HERDR_STREAM_PATH}?${q}`;
  }

  private connect(): void {
    if (this.stopped || this.paused) return;
    this.teardown();
    this.h.onStatus(this.everReady || this.failures > 0 ? "reconnecting" : "connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url());
    } catch (e) {
      this.scheduleRetry(String(e));
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") {
        this.h.onBytes(new Uint8Array(e.data as ArrayBuffer));
        return;
      }
      let msg: HerdrStreamServerMessage;
      try {
        msg = JSON.parse(e.data) as HerdrStreamServerMessage;
      } catch {
        return;
      }
      if (msg.t === "ready") {
        this.failures = 0;
        this.everReady = true;
        this.h.onStatus("live");
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.send({ t: "ping" }), PING_MS);
      }
      this.h.onMessage(msg);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.stopped || this.paused) return;
      if (e.code === CLOSE_PANE_GONE) {
        this.h.onStatus("offline", "窗格已关闭");
        return;
      }
      if (e.code === CLOSE_UNSUPPORTED) {
        this.h.onStatus("unsupported", e.reason || "herdr 不支持实时观察");
        return;
      }
      this.scheduleRetry(e.reason || `连接断开（${e.code}）`);
    };
  }

  private scheduleRetry(reason: string): void {
    if (this.stopped || this.paused) return;
    this.failures++;
    if (this.failures >= FALLBACK_AFTER_FAILURES && !this.everReady) {
      // 一次都没连上过、还连续失败：多半是大门太旧（没有这个端点）或中间代理不放 WS。
      this.h.onStatus("unsupported", reason);
      return;
    }
    this.h.onStatus("reconnecting", reason);
    const delay = reconnectDelayMs(this.failures - 1);
    this.retryTimer = setTimeout(() => void this.probeThenConnect(), delay);
  }

  // WS 握手失败时浏览器拿不到 HTTP 状态码——没登录和断网看起来一模一样。重连前先用
  // 同一路径的普通 GET 问一下：401 就别再连了（一直重连只会刷屏），让用户去登录。
  private async probeThenConnect(): Promise<void> {
    if (this.stopped || this.paused) return;
    try {
      const r = await fetch(HERDR_STREAM_PATH, { cache: "no-store", credentials: "same-origin" });
      if (r.status === 401) {
        this.h.onStatus("offline", "登录已失效，请刷新页面重新登录");
        return;
      }
      // 404（大门旧版本没有这条路径、请求落进了 Next）/ 503（维护页、流已满）按普通失败继续
      // 退避，攒够次数自然回退轮询。
      if (r.ok) {
        const body = (await r.json().catch(() => null)) as { enabled?: boolean } | null;
        if (body && body.enabled === false) {
          this.h.onStatus("unsupported", "herdr 已在本机关闭");
          return;
        }
      }
    } catch {
      /* 断网：照常退避重连 */
    }
    if (!this.stopped && !this.paused) this.connect();
  }
}
