// 网关的 WebSocket 反代（浏览器 ⇄ 网关 ⇄ 本机租户 / 远端 node 的虚拟端口）。
// 从 gateway.ts 拆出来是为了能单测「慢客户端保护」——逻辑本身沿用原来的逐消息转发。
//
// 已实测的行为（2026-10-30，hub 隔离实例 + 真隧道）：
//   · 关闭码与 reason 双向原样透传（4404 "pane closed"、1011 "observe ended" 都到得了浏览器）；
//   · 上游握手不带 Origin（Bun 的 WebSocket 客户端不发），Host 是 127.0.0.1:<端口>；
//   · 单条消息：下行 17 MB 照样到达；上行受网关 Bun.serve 默认 maxPayloadLength（16 MB）限制，
//     超了是 1006。trellis 的终端流单条上限是 512 KiB 量级，远够不着。

import type { ServerWebSocket } from "bun";

export type ProxySocketData = {
  kind: "proxy";
  target: string;
  cookie: string;
  protocols: string[];
  upstream?: WebSocket;
  queue: (string | Uint8Array)[];
};

/**
 * 浏览器读不动时网关这一侧最多替它攒多少。上游（远端 node）经隧道过来时，node 自己的
 * 背压判断只看得到本机那段 TCP（隧道客户端读得飞快），慢的是网关 → 浏览器这一段——
 * 不设上限的话，手机弱网挂着一条忙碌的终端，字节会一直堆在网关进程里。
 * 超限就断开（1013 Try Again Later）：终端流的浏览器侧会重连并拿到一帧全新的整屏，
 * 比无限缓冲后再一口气灌给浏览器强。
 */
export const CLIENT_BUFFER_LIMIT = 8 * 1024 * 1024;
// 积压这么多时 bun 往往来不及把关闭帧排出去，浏览器看到的多半是 1006——终端流两种都按「重连」处理。
export const CLOSE_CLIENT_TOO_SLOW = 1013;

type ClientLike = Pick<ServerWebSocket<ProxySocketData>, "send" | "getBufferedAmount" | "close">;

/** 上游来一条消息：转给浏览器；浏览器积压过多则两头一起断。返回是否已断开。 */
export function forwardToClient(
  ws: ClientLike,
  upstream: Pick<WebSocket, "close"> | undefined,
  data: string | ArrayBuffer | Uint8Array,
  limit = CLIENT_BUFFER_LIMIT,
): boolean {
  if (ws.getBufferedAmount() > limit) {
    console.warn(`[trellis-gw] ws 客户端积压 ${ws.getBufferedAmount()} B 超过上限，断开`);
    closeClient(ws, CLOSE_CLIENT_TOO_SLOW, "client too slow");
    try { upstream?.close(1000, "client too slow"); } catch { /* already closed */ }
    return true;
  }
  ws.send(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  return false;
}

export function closeClient(ws: Pick<ClientLike, "close">, code = 1011, reason = "upstream closed"): void {
  try { ws.close(code, reason); } catch { /* already closed */ }
}

// Bun 的 WebSocket 客户端支持握手自定义 headers/protocols(bun-types WebSocketOptionsHeaders);
// next build 的 tsc 走 DOM lib 看不到这个扩展签名,局部断言之。
type BunWebSocketCtor = new (
  url: string,
  opts?: { headers?: Record<string, string>; protocols?: string[] },
) => WebSocket;

export const wsProxy = {
  open(ws: ServerWebSocket<ProxySocketData>): void {
    const data = ws.data;
    const options = { headers: { cookie: data.cookie }, protocols: data.protocols };
    const upstream = new (WebSocket as unknown as BunWebSocketCtor)(data.target, options);
    upstream.binaryType = "arraybuffer";
    data.upstream = upstream;
    upstream.onopen = () => {
      for (const message of data.queue) upstream.send(message);
      data.queue.length = 0;
    };
    upstream.onmessage = (event) => {
      forwardToClient(ws, upstream, event.data as string | ArrayBuffer);
    };
    upstream.onclose = (event) => closeClient(ws, event.code || 1000, event.reason);
    upstream.onerror = () => closeClient(ws);
  },
  message(ws: ServerWebSocket<ProxySocketData>, message: string | Buffer): void {
    const data = ws.data;
    const frame = typeof message === "string" ? message : new Uint8Array(message);
    if (data.upstream?.readyState === WebSocket.OPEN) data.upstream.send(frame);
    else data.queue.push(frame);
  },
  close(ws: ServerWebSocket<ProxySocketData>, code: number, reason: string): void {
    try { ws.data.upstream?.close(code, reason); } catch { /* already closed */ }
  },
};
