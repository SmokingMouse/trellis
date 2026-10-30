import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Server } from "bun";
import { CLOSE_CLIENT_TOO_SLOW, forwardToClient, wsProxy, type ProxySocketData } from "./ws-proxy";

// 上游：模拟 node 大门。按路径做终端流会用到的几种行为。
let upstream: Server<{ path: string; origin: string | null }>;
// 网关：只挂 wsProxy，路由全部指向上游。
let gateway: Server<ProxySocketData>;

beforeAll(() => {
  upstream = Bun.serve<{ path: string; origin: string | null }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      server.upgrade(req, { data: { path: url.pathname, origin: req.headers.get("origin") } });
      return undefined;
    },
    websocket: {
      open(ws) {
        if (ws.data.path === "/close4404") ws.close(4404, "pane closed");
        if (ws.data.path === "/origin") ws.send(JSON.stringify({ origin: ws.data.origin }));
        if (ws.data.path === "/big") ws.send(new Uint8Array(4 * 1024 * 1024).fill(7));
        if (ws.data.path === "/many") {
          for (let i = 0; i < 500; i++) ws.send(`f${i}`);
        }
      },
      message(ws, m) {
        ws.send(m);
      },
    },
  });
  gateway = Bun.serve<ProxySocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      const target = `ws://127.0.0.1:${upstream.port}${url.pathname}`;
      if (server.upgrade(req, { data: { kind: "proxy", target, cookie: "trellis_auth=t", protocols: [], queue: [] } })) {
        return undefined;
      }
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: wsProxy,
  });
});

afterAll(() => {
  gateway?.stop(true);
  upstream?.stop(true);
});

function connect(path: string, headers: Record<string, string> = {}) {
  type BunWS = new (u: string, o?: { headers?: Record<string, string> }) => WebSocket;
  const ws = new (WebSocket as unknown as BunWS)(`ws://127.0.0.1:${gateway.port}${path}`, { headers });
  ws.binaryType = "arraybuffer";
  return ws;
}

test("关闭码与 reason 原样透传给浏览器（终端流靠 4404 判断窗格已关、别再重连）", async () => {
  const ws = connect("/close4404");
  const ev = await new Promise<CloseEvent>((resolve) => (ws.onclose = resolve));
  expect(ev.code).toBe(4404);
  expect(ev.reason).toBe("pane closed");
});

test("浏览器的 Origin 不会被带到上游（上游的同源校验因此只靠 cookie 闸）", async () => {
  const ws = connect("/origin", { origin: "https://hub.example" });
  const msg = await new Promise<string>((resolve) => (ws.onmessage = (e) => resolve(String(e.data))));
  ws.close();
  expect(JSON.parse(msg)).toEqual({ origin: null });
});

test("大二进制帧（4 MB 整屏）与连发小帧都完整、按序到达", async () => {
  const big = connect("/big");
  const size = await new Promise<number>((resolve) => (big.onmessage = (e) => resolve((e.data as ArrayBuffer).byteLength)));
  big.close();
  expect(size).toBe(4 * 1024 * 1024);

  const many = connect("/many");
  const got: string[] = [];
  await new Promise<void>((resolve) => {
    many.onmessage = (e) => {
      got.push(String(e.data));
      if (got.length === 500) resolve();
    };
  });
  many.close();
  expect(got[0]).toBe("f0");
  expect(got[499]).toBe("f499");
  expect(new Set(got).size).toBe(500);
});

test("上游连上之前浏览器发的消息先排队，连上后补发", async () => {
  const ws = connect("/echo");
  const echoed = await new Promise<string>((resolve) => {
    ws.onopen = () => ws.send("early");
    ws.onmessage = (e) => resolve(String(e.data));
  });
  ws.close();
  expect(echoed).toBe("early");
});

test("慢客户端：积压未超限照常转发，超限则两头一起断（1013）", () => {
  const sent: unknown[] = [];
  const closes: [number | undefined, string | undefined][] = [];
  let buffered = 0;
  const ws = {
    send: (d: unknown) => {
      sent.push(d);
      return 1;
    },
    getBufferedAmount: () => buffered,
    close: (code?: number, reason?: string) => {
      closes.push([code, reason]);
    },
  };
  const upstreamCloses: (number | undefined)[] = [];
  const up = { close: (code?: number) => upstreamCloses.push(code) };

  expect(forwardToClient(ws, up, "a", 100)).toBe(false);
  buffered = 100;
  expect(forwardToClient(ws, up, new ArrayBuffer(3), 100)).toBe(false);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toBeInstanceOf(Uint8Array);

  buffered = 101;
  expect(forwardToClient(ws, up, "b", 100)).toBe(true);
  expect(sent).toHaveLength(2);
  expect(closes).toEqual([[CLOSE_CLIENT_TOO_SLOW, "client too slow"]]);
  expect(upstreamCloses).toEqual([1000]);
});
