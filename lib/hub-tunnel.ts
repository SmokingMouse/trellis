// hub 隧道：让一台「外面连不进来、但能出站」的 trellis 实例挂到 hub 上。
//
//   office 机器                                   hub（gateway）
//   server.ts ── startHubTunnel() ══ WS 443 ══▶ /__gw/tunnel
//      ▲                                            │ 每个 node 一个 127.0.0.1 虚拟端口
//      └── Bun.connect 127.0.0.1:PORT ◀── OPEN/DATA/CLOSE ── 网关对虚拟端口的 TCP 连接
//
// 为什么在 TCP 层而不是 HTTP 层复用：网关现有的 HTTP / SSE / WS 反代（含它踩过的
// Host 改写、cookie 翻译、abort 传导那些坑）对远端 node 原样可用——远端 node 在
// 网关眼里就是一个本机端口。HTTP 层复用要把 SSE 分块、WS 升级各重写一遍。
//
// 线格式：
//   二进制帧 = [type u8][stream u32 BE][payload]，type ∈ OPEN / DATA / CLOSE
//   文本帧   = JSON 控制消息（hello / ping / pong），走同一条连接
// 连接永远由 node 发起，hub 从不主动连 node。

export const FRAME_OPEN = 1;
export const FRAME_DATA = 2;
export const FRAME_CLOSE = 3;

export type Frame = { type: number; stream: number; payload: Uint8Array };

export type ControlMessage =
  | { type: "hello"; gateToken: string; version: string }
  | { type: "ping"; at: number }
  | { type: "pong"; at: number };

export const TUNNEL_PATH = "/__gw/tunnel";
export const HEARTBEAT_MS = 20_000;
export const DEAD_AFTER_MS = 60_000;

export function encodeFrame(type: number, stream: number, payload?: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + (payload?.byteLength ?? 0));
  out[0] = type;
  new DataView(out.buffer).setUint32(1, stream);
  if (payload) out.set(payload, 5);
  return out;
}

export function decodeFrame(data: Uint8Array): Frame | null {
  if (data.byteLength < 5) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { type: data[0], stream: view.getUint32(1), payload: data.subarray(5) };
}

/**
 * TCP 写入的最小封装：Bun 的 socket.write 可能只写进去一部分，剩下的必须等
 * drain 再续写，否则字节静默丢失（SSE 流到一半断字）。
 */
export class SocketWriter {
  private queue: Uint8Array[] = [];
  private ending = false;
  constructor(private socket: { write(d: Uint8Array): number; end(): void }) {}

  write(chunk: Uint8Array): void {
    if (this.queue.length) {
      this.queue.push(chunk);
      return;
    }
    const n = this.socket.write(chunk);
    if (n < chunk.byteLength) this.queue.push(chunk.subarray(Math.max(n, 0)));
  }

  /** 由 socket 的 drain 回调调用。 */
  drain(): void {
    while (this.queue.length) {
      const head = this.queue[0];
      const n = this.socket.write(head);
      if (n < head.byteLength) {
        this.queue[0] = head.subarray(Math.max(n, 0));
        return;
      }
      this.queue.shift();
    }
    if (this.ending) this.socket.end();
  }

  end(): void {
    this.ending = true;
    if (!this.queue.length) this.socket.end();
  }
}

// ── node 侧客户端 ──────────────────────────────────────────────────────────

export type HubTunnelOptions = {
  /** hub 的基址，如 https://trellis.example.com；ws/wss 也认。 */
  hubURL: string;
  nodeName: string;
  nodeToken: string;
  /** 本机 trellis 大门端口（server.ts 的 PORT）。 */
  localPort: number;
  /** 本机大门的 cookie 闸 token，hub 转发时注入；闸关时为空串。 */
  gateToken: string;
  version?: string;
  /** 出站代理（公司网络），缺省读 HTTPS_PROXY / https_proxy。 */
  proxy?: string;
  log?: (msg: string) => void;
};

export function tunnelURL(hubURL: string): string {
  const u = new URL(hubURL);
  if (u.protocol === "https:") u.protocol = "wss:";
  else if (u.protocol === "http:") u.protocol = "ws:";
  u.pathname = TUNNEL_PATH;
  u.search = "";
  return u.toString();
}

// 重连阶梯 + ±10% 抖动（参考 herdrx web/src/lib/workbench.ts 的做法）。
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];

export function backoffDelay(attempt: number, rand = Math.random): number {
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  return Math.round(base * (0.9 + rand() * 0.2));
}

type LocalStream = {
  socket?: { write(d: Uint8Array): number; end(): void };
  writer?: SocketWriter;
  pending: Uint8Array[];
  closed: boolean;
};

export type HubTunnelHandle = { stop(): void; connected(): boolean };

export function startHubTunnel(opts: HubTunnelOptions): HubTunnelHandle {
  const log = opts.log ?? ((m: string) => console.log(`[trellis] hub tunnel: ${m}`));
  const url = tunnelURL(opts.hubURL);
  const proxy = opts.proxy ?? (process.env.HTTPS_PROXY || process.env.https_proxy || undefined);
  let stopped = false;
  let attempt = 0;
  let ws: WebSocket | null = null;
  let open = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (stopped) return;
    const streams = new Map<number, LocalStream>();
    let lastSeen = Date.now();
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    // Bun 的 WebSocket 客户端支持握手 headers 与 proxy（bun-types WebSocketOptions）；
    // next build 的 tsc 走 DOM lib 看不到这个扩展签名，局部断言之（同 gateway.ts）。
    type BunWebSocketCtor = new (
      url: string,
      opts?: { headers?: Record<string, string>; proxy?: string },
    ) => WebSocket;
    const sock = new (WebSocket as unknown as BunWebSocketCtor)(url, {
      headers: {
        authorization: `Bearer ${opts.nodeToken}`,
        "x-trellis-node": opts.nodeName,
      },
      ...(proxy ? { proxy } : {}),
    });
    sock.binaryType = "arraybuffer";
    ws = sock;

    const send = (data: Uint8Array | string) => {
      if (sock.readyState === WebSocket.OPEN) sock.send(data);
    };
    const closeStream = (id: number, notify: boolean) => {
      const s = streams.get(id);
      if (!s || s.closed) return;
      s.closed = true;
      streams.delete(id);
      if (s.writer) s.writer.end();
      if (notify) send(encodeFrame(FRAME_CLOSE, id));
    };

    const openStream = (id: number) => {
      const s: LocalStream = { pending: [], closed: false };
      streams.set(id, s);
      Bun.connect({
        hostname: "127.0.0.1",
        port: opts.localPort,
        socket: {
          open(socket) {
            if (s.closed) {
              socket.end();
              return;
            }
            s.socket = socket;
            s.writer = new SocketWriter(socket);
            for (const chunk of s.pending) s.writer.write(chunk);
            s.pending.length = 0;
          },
          data(_socket, chunk) {
            send(encodeFrame(FRAME_DATA, id, new Uint8Array(chunk)));
          },
          drain() {
            s.writer?.drain();
          },
          close() {
            closeStream(id, true);
          },
          error() {
            closeStream(id, true);
          },
        },
      }).catch(() => closeStream(id, true));
    };

    sock.onopen = () => {
      open = true;
      attempt = 0;
      lastSeen = Date.now();
      log(`connected to ${url} as ${opts.nodeName}`);
      const hello: ControlMessage = { type: "hello", gateToken: opts.gateToken, version: opts.version ?? "" };
      sock.send(JSON.stringify(hello));
      heartbeat = setInterval(() => {
        // 公司出口代理会掐空闲长连接；心跳同时也是死连接探测。
        if (Date.now() - lastSeen > DEAD_AFTER_MS) {
          log("heartbeat timeout — reconnecting");
          try { sock.close(); } catch { /* already closed */ }
          return;
        }
        send(JSON.stringify({ type: "ping", at: Date.now() } satisfies ControlMessage));
      }, HEARTBEAT_MS);
    };

    sock.onmessage = (event) => {
      lastSeen = Date.now();
      if (typeof event.data === "string") return; // pong 等控制消息，只用于保活
      const frame = decodeFrame(new Uint8Array(event.data as ArrayBuffer));
      if (!frame) return;
      if (frame.type === FRAME_OPEN) openStream(frame.stream);
      else if (frame.type === FRAME_DATA) {
        const s = streams.get(frame.stream);
        if (!s) return;
        // payload 是 subarray，排队前拷一份，别被后续帧复用的缓冲区覆盖。
        const chunk = frame.payload.slice();
        if (s.writer) s.writer.write(chunk);
        else s.pending.push(chunk);
      } else if (frame.type === FRAME_CLOSE) closeStream(frame.stream, false);
    };

    sock.onclose = (event) => {
      if (heartbeat) clearInterval(heartbeat);
      const wasOpen = open;
      open = false;
      for (const id of [...streams.keys()]) closeStream(id, false);
      if (stopped) return;
      // 401/403 也会走到这里（握手被拒）。照样退避重试：撤销后日志会持续报错，
      // 这正是想要的可见性；退避封顶 30s，不会打爆 hub。
      const delay = backoffDelay(attempt++);
      log(`${wasOpen ? "disconnected" : "connect failed"} (code=${event.code}) — retry in ${delay}ms`);
      retryTimer = setTimeout(connect, delay);
    };
    sock.onerror = () => {
      /* onclose 紧随其后，统一在那里处理 */
    };
  };

  connect();
  return {
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      try { ws?.close(); } catch { /* already closed */ }
    },
    connected: () => open,
  };
}
