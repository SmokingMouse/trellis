import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Server } from "bun";
import { openGatewayDB } from "./db";
import { addNode, authenticateNode, liveNode, revokeNode, tunnelClose, tunnelMessage, tunnelOpen, type TunnelSocketData, _forTests } from "./tunnel";
import { addUser } from "./auth";
import { TUNNEL_PATH, backoffDelay, decodeFrame, encodeFrame, startHubTunnel, tunnelURL, type HubTunnelHandle } from "../../lib/hub-tunnel";

const db = openGatewayDB(":memory:");
let hub: Server<TunnelSocketData>;
let office: Server<undefined>;
let client: HubTunnelHandle;
let token = "";

async function until<T>(fn: () => T | null | undefined | false, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timeout");
    await Bun.sleep(20);
  }
}

beforeAll(() => {
  addUser(db, "admin", "host-admin", "admin");
  const owner = db.prepare("SELECT id FROM users WHERE name='admin'").get() as { id: string };
  token = addNode(db, "office", owner.id);

  // 模拟 office 上的 trellis 大门：SSE、回显 POST、WS 回显，外加检查 cookie 是否被透传。
  office = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws" && server.upgrade(req)) return undefined;
      if (url.pathname === "/sse") {
        let i = 0;
        const stream = new ReadableStream({
          async pull(controller) {
            if (i === 5) return controller.close();
            await Bun.sleep(150);
            controller.enqueue(new TextEncoder().encode(`data: ${i++}\n\n`));
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      if (url.pathname === "/echo") return new Response(req.body);
      return Response.json({ cookie: req.headers.get("cookie") });
    },
    websocket: {
      message(ws, msg) {
        ws.send(msg);
      },
    },
  });

  hub = Bun.serve<TunnelSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (new URL(req.url).pathname !== TUNNEL_PATH) return new Response("nope", { status: 404 });
      const node = authenticateNode(db, req);
      if (!node) return new Response("Unauthorized", { status: 401 });
      if (server.upgrade(req, { data: { kind: "tunnel", node } })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open: (ws) => tunnelOpen(db, ws),
      message: (ws, m) => tunnelMessage(db, ws, m),
      close: (ws) => tunnelClose(ws),
    },
  });

  client = startHubTunnel({
    hubURL: `http://127.0.0.1:${hub.port}`,
    nodeName: "office",
    nodeToken: token,
    localPort: office.port!,
    gateToken: "gate-secret",
    version: "test",
    proxy: "",
    log: () => {},
  });
});

afterAll(() => {
  client?.stop();
  hub?.stop(true);
  office?.stop(true);
});

test("帧编解码往返", () => {
  const f = decodeFrame(encodeFrame(2, 0xdeadbeef, new Uint8Array([1, 2, 3])))!;
  expect(f.type).toBe(2);
  expect(f.stream).toBe(0xdeadbeef);
  expect([...f.payload]).toEqual([1, 2, 3]);
  expect(decodeFrame(new Uint8Array(3))).toBeNull();
});

test("tunnelURL 与退避阶梯", () => {
  expect(tunnelURL("https://hub.example.com/x?y=1")).toBe("wss://hub.example.com/__gw/tunnel");
  expect(tunnelURL("http://127.0.0.1:3200")).toBe("ws://127.0.0.1:3200/__gw/tunnel");
  expect(backoffDelay(0, () => 0.5)).toBe(1000);
  expect(backoffDelay(99, () => 0.5)).toBe(30_000);
});

test("node 连上并完成 hello", async () => {
  const n = await until(() => liveNode("office"));
  expect(n.gateToken).toBe("gate-secret");
  expect(n.version).toBe("test");
});

test("普通请求经虚拟端口到达 office", async () => {
  const n = await until(() => liveNode("office"));
  const r = await fetch(`http://127.0.0.1:${n.port}/whoami`, { headers: { cookie: "trellis_auth=x" } });
  expect(await r.json()).toEqual({ cookie: "trellis_auth=x" });
});

test("SSE 逐条到达，不被攒批", async () => {
  const n = await until(() => liveNode("office"));
  const r = await fetch(`http://127.0.0.1:${n.port}/sse`);
  const reader = r.body!.getReader();
  const arrivals: number[] = [];
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    arrivals.push(Date.now());
    text += new TextDecoder().decode(value);
  }
  expect(text).toBe([0, 1, 2, 3, 4].map((i) => `data: ${i}\n\n`).join(""));
  // 5 条事件间隔 150ms：若被缓冲成一次到达，首末时间差会接近 0。
  expect(arrivals.length).toBeGreaterThanOrEqual(4);
  expect(arrivals.at(-1)! - arrivals[0]).toBeGreaterThan(400);
});

test("大请求体完整往返（覆盖部分写 / drain）", async () => {
  const n = await until(() => liveNode("office"));
  const body = new Uint8Array(4 * 1024 * 1024);
  for (let i = 0; i < body.length; i++) body[i] = (i * 31) & 0xff;
  const r = await fetch(`http://127.0.0.1:${n.port}/echo`, { method: "POST", body });
  const back = new Uint8Array(await r.arrayBuffer());
  expect(back.length).toBe(body.length);
  expect(Bun.hash(back)).toBe(Bun.hash(body));
});

test("WebSocket（终端）双向透传", async () => {
  const n = await until(() => liveNode("office"));
  const ws = new WebSocket(`ws://127.0.0.1:${n.port}/ws`);
  ws.binaryType = "arraybuffer";
  const got = await new Promise<string>((resolve, reject) => {
    ws.onopen = () => ws.send("ping-through-tunnel");
    ws.onmessage = (e) => resolve(String(e.data));
    ws.onerror = () => reject(new Error("ws error"));
  });
  ws.close();
  expect(got).toBe("ping-through-tunnel");
});

test("错误 token 被拒，不会上线", async () => {
  const bad = startHubTunnel({
    hubURL: `http://127.0.0.1:${hub.port}`,
    nodeName: "ghost",
    nodeToken: "tn_wrong",
    localPort: office.port!,
    gateToken: "",
    proxy: "",
    log: () => {},
  });
  await Bun.sleep(300);
  expect(bad.connected()).toBe(false);
  expect(liveNode("ghost")).toBeNull();
  bad.stop();
});

test("隧道被断开后自动重连", async () => {
  const before = await until(() => liveNode("office"));
  _forTests.live.get("office")!.ws.close(4000, "test kick");
  await until(() => !liveNode("office") || liveNode("office")!.connectedAt !== before.connectedAt);
  const after = await until(() => {
    const n = liveNode("office");
    return n && n.connectedAt !== before.connectedAt ? n : null;
  }, 5000);
  const r = await fetch(`http://127.0.0.1:${after.port}/whoami`);
  expect(r.status).toBe(200);
});

test("撤销后立即断开且无法重连", async () => {
  await until(() => liveNode("office"));
  expect(revokeNode(db, "office")).toBe(true);
  await until(() => !liveNode("office"));
  await Bun.sleep(1500);
  expect(liveNode("office")).toBeNull();
});

test("配对：票据一次性、过期作废、名字要对上", async () => {
  const { createPairing, redeemPairing, PAIRING_TTL_MS } = await import("./tunnel");
  const owner = db.prepare("SELECT id FROM users WHERE name='admin'").get() as { id: string };
  expect(createPairing(db, "Bad Name", owner.id)).toEqual({ error: "invalid_name" });

  const p = createPairing(db, "devbox", owner.id) as { ticket: string; expiresAt: number };
  expect(redeemPairing(db, p.ticket, "other")).toBeNull();
  const token = redeemPairing(db, p.ticket, "devbox");
  expect(token).toMatch(/^tn_/);
  expect(redeemPairing(db, p.ticket, "devbox")).toBeNull();

  const req = (t: string) => new Request("http://x", { headers: { authorization: `Bearer ${t}`, "x-trellis-node": "devbox" } });
  expect(authenticateNode(db, req(token!))).toBe("devbox");

  // 再配对 = 轮换：旧 token 失效。
  const p2 = createPairing(db, "devbox", owner.id) as { ticket: string };
  const token2 = redeemPairing(db, p2.ticket, "devbox");
  expect(authenticateNode(db, req(token!))).toBeNull();
  expect(authenticateNode(db, req(token2!))).toBe("devbox");

  const old = createPairing(db, "late", owner.id, Date.now() - PAIRING_TTL_MS - 1) as { ticket: string };
  expect(redeemPairing(db, old.ticket, "late")).toBeNull();
});

test("配对：别人的 node 名不能抢", async () => {
  const { createPairing } = await import("./tunnel");
  addUser(db, "bob", "bob");
  const bob = db.prepare("SELECT id FROM users WHERE name='bob'").get() as { id: string };
  expect(createPairing(db, "devbox", bob.id)).toEqual({ error: "taken" });
});
