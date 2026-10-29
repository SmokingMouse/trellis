// hub 侧隧道：远端 node 连进 /__gw/tunnel 后，网关给它开一个 127.0.0.1 虚拟端口，
// 对这个端口的每条 TCP 连接都复用进那条 WS。于是网关的反代代码不需要知道
// 「远端」这回事——远端 node 就是一个 Tenant { kind: "remote", hostPort: 虚拟端口 }。
// 协议与 node 侧客户端见 lib/hub-tunnel.ts。

import type { Database } from "bun:sqlite";
import type { ServerWebSocket, Socket, TCPSocketListener } from "bun";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  DEAD_AFTER_MS,
  FRAME_CLOSE,
  FRAME_DATA,
  FRAME_OPEN,
  SocketWriter,
  decodeFrame,
  encodeFrame,
  type ControlMessage,
} from "../../lib/hub-tunnel";
import { sha256 } from "./auth";

export type NodeRow = {
  name: string;
  owner_id: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number | null;
  revoked: number;
};

export type TunnelSocketData = {
  kind: "tunnel";
  node: string;
};

type Conn = { socket: Socket<{ id: number }>; writer: SocketWriter };

type LiveNode = {
  name: string;
  ownerId: string;
  ws: ServerWebSocket<TunnelSocketData>;
  listener: TCPSocketListener<{ id: number }>;
  port: number;
  gateToken: string | null;
  version: string;
  connectedAt: number;
  lastSeen: number;
  nextStream: number;
  conns: Map<number, Conn>;
};

const live = new Map<string, LiveNode>();

export const NODE_NAME = /^[a-z0-9-]{1,32}$/;

// ── 登记（CLI / admin）──────────────────────────────────────────────────────

/** 新建 node，返回明文 token（只出现这一次，库里只存哈希）。 */
export function addNode(db: Database, name: string, ownerId: string): string {
  if (!NODE_NAME.test(name)) throw new Error("node name must match ^[a-z0-9-]{1,32}$");
  const token = `tn_${randomBytes(32).toString("base64url")}`;
  db.prepare(
    "INSERT INTO nodes (name,owner_id,token_hash,created_at,revoked) VALUES (?,?,?,?,0)",
  ).run(name, ownerId, sha256(token), Date.now());
  return token;
}

// ── 配对：一次性连接串换长期 token ────────────────────────────────────────────
// 连接串只带短时票据（10 分钟、一次性、库里存哈希）；长期 token 由 node 自己
// 拿票据来换，不经过人手。同一 owner 对已有 node 再配对 = 轮换 token（旧 token
// 立即失效、旧隧道断开），用于 node 丢了配置文件的情况。

export const PAIRING_TTL_MS = 10 * 60 * 1000;

export type PairingError = "invalid_name" | "taken";

export function createPairing(
  db: Database,
  name: string,
  ownerId: string,
  now = Date.now(),
): { ticket: string; expiresAt: number } | { error: PairingError } {
  if (!NODE_NAME.test(name)) return { error: "invalid_name" };
  const existing = db.prepare("SELECT owner_id,revoked FROM nodes WHERE name=?").get(name) as
    | { owner_id: string; revoked: number }
    | null;
  if (existing && existing.owner_id !== ownerId && !existing.revoked) return { error: "taken" };
  const ticket = `tp_${randomBytes(24).toString("base64url")}`;
  const expiresAt = now + PAIRING_TTL_MS;
  db.prepare(
    "INSERT INTO pairings (ticket_hash,name,owner_id,created_at,expires_at) VALUES (?,?,?,?,?)",
  ).run(sha256(ticket), name, ownerId, now, expiresAt);
  return { ticket, expiresAt };
}

/** 兑换票据。成功返回长期 token；票据不存在 / 过期 / 已用 / 名字对不上一律 null。 */
export function redeemPairing(db: Database, ticket: string, name: string, now = Date.now()): string | null {
  const row = db.prepare(
    "SELECT ticket_hash,name,owner_id,expires_at,used_at FROM pairings WHERE ticket_hash=?",
  ).get(sha256(ticket)) as
    | { ticket_hash: string; name: string; owner_id: string; expires_at: number; used_at: number | null }
    | null;
  if (!row || row.used_at !== null || row.expires_at < now || row.name !== name) return null;
  const token = `tn_${randomBytes(32).toString("base64url")}`;
  const tx = db.transaction(() => {
    // 先占票据：并发兑换同一张票，只有一个能把 used_at 从 NULL 改掉。
    const claimed = db.prepare(
      "UPDATE pairings SET used_at=? WHERE ticket_hash=? AND used_at IS NULL",
    ).run(now, row.ticket_hash).changes;
    if (!claimed) return false;
    db.prepare(`
      INSERT INTO nodes (name,owner_id,token_hash,created_at,revoked) VALUES (?,?,?,?,0)
      ON CONFLICT(name) DO UPDATE SET owner_id=excluded.owner_id, token_hash=excluded.token_hash, revoked=0
    `).run(row.name, row.owner_id, sha256(token), now);
    return true;
  });
  if (!tx()) return null;
  // 轮换：还挂着旧 token 的隧道立刻断开。
  live.get(row.name)?.ws.close(4001, "token rotated");
  return token;
}

export function revokeNode(db: Database, name: string): boolean {
  const changed = db.prepare("UPDATE nodes SET revoked=1 WHERE name=?").run(name).changes > 0;
  // 撤销即断开：已建立的隧道与其上所有连接立刻失效。
  live.get(name)?.ws.close(4003, "revoked");
  return changed;
}

export function listNodes(db: Database, ownerId?: string): NodeRow[] {
  const sql = "SELECT name,owner_id,token_hash,created_at,last_seen_at,revoked FROM nodes";
  return (ownerId
    ? db.prepare(`${sql} WHERE owner_id=? ORDER BY name`).all(ownerId)
    : db.prepare(`${sql} ORDER BY name`).all()) as NodeRow[];
}

// ── 握手鉴权 ────────────────────────────────────────────────────────────────

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** 校验 node 的握手请求。通过返回 node 名，否则返回 null（一律 401，不区分原因）。 */
export function authenticateNode(db: Database, req: Request): string | null {
  const name = req.headers.get("x-trellis-node") || "";
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!NODE_NAME.test(name) || !token) return null;
  const row = db.prepare("SELECT token_hash,revoked FROM nodes WHERE name=?").get(name) as
    | { token_hash: string; revoked: number }
    | null;
  if (!row || row.revoked) return null;
  return sameHash(row.token_hash, sha256(token)) ? name : null;
}

// ── 运行期 ──────────────────────────────────────────────────────────────────

export type LiveNodeView = { port: number; gateToken: string; version: string; connectedAt: number };

/** 在线且已完成 hello 的 node；路由只认这个。 */
export function liveNode(name: string): LiveNodeView | null {
  const n = live.get(name);
  if (!n || n.gateToken === null) return null;
  return { port: n.port, gateToken: n.gateToken, version: n.version, connectedAt: n.connectedAt };
}

function sendFrame(n: LiveNode, data: Uint8Array): void {
  n.ws.send(data);
}

function dropConn(n: LiveNode, id: number, notify: boolean): void {
  const c = n.conns.get(id);
  if (!c) return;
  n.conns.delete(id);
  c.writer.end();
  if (notify) sendFrame(n, encodeFrame(FRAME_CLOSE, id));
}

function teardown(n: LiveNode): void {
  if (live.get(n.name) === n) live.delete(n.name);
  for (const id of [...n.conns.keys()]) dropConn(n, id, false);
  n.listener.stop(true);
}

export function tunnelOpen(db: Database, ws: ServerWebSocket<TunnelSocketData>): void {
  const name = ws.data.node;
  const row = db.prepare("SELECT owner_id FROM nodes WHERE name=?").get(name) as { owner_id: string } | null;
  if (!row) {
    ws.close(4003, "unknown node");
    return;
  }
  // 同名 node 重连（旧连接还没被判死）：新的顶掉旧的。
  const prev = live.get(name);
  if (prev) {
    teardown(prev);
    try { prev.ws.close(4000, "replaced"); } catch { /* already closed */ }
  }

  const n = {
    name,
    ownerId: row.owner_id,
    ws,
    gateToken: null,
    version: "",
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    nextStream: 1,
    conns: new Map(),
  } as unknown as LiveNode;

  n.listener = Bun.listen<{ id: number }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        const id = n.nextStream++;
        socket.data = { id };
        n.conns.set(id, { socket, writer: new SocketWriter(socket) });
        sendFrame(n, encodeFrame(FRAME_OPEN, id));
      },
      data(socket, chunk) {
        sendFrame(n, encodeFrame(FRAME_DATA, socket.data.id, new Uint8Array(chunk)));
      },
      drain(socket) {
        n.conns.get(socket.data.id)?.writer.drain();
      },
      close(socket) {
        dropConn(n, socket.data.id, true);
      },
      error(socket) {
        dropConn(n, socket.data.id, true);
      },
    },
  });
  n.port = n.listener.port;
  live.set(name, n);
  db.prepare("UPDATE nodes SET last_seen_at=? WHERE name=?").run(Date.now(), name);
  console.log(`[trellis-gw] node ${name} connected → 127.0.0.1:${n.port}`);
}

export function tunnelMessage(db: Database, ws: ServerWebSocket<TunnelSocketData>, message: string | Buffer): void {
  const n = live.get(ws.data.node);
  if (!n || n.ws !== ws) return;
  n.lastSeen = Date.now();
  if (typeof message === "string") {
    let msg: ControlMessage;
    try {
      msg = JSON.parse(message) as ControlMessage;
    } catch {
      return;
    }
    if (msg.type === "hello") {
      n.gateToken = typeof msg.gateToken === "string" ? msg.gateToken : "";
      n.version = typeof msg.version === "string" ? msg.version.slice(0, 64) : "";
    } else if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", at: msg.at } satisfies ControlMessage));
      db.prepare("UPDATE nodes SET last_seen_at=? WHERE name=?").run(n.lastSeen, n.name);
    }
    return;
  }
  const frame = decodeFrame(new Uint8Array(message));
  if (!frame) return;
  const c = n.conns.get(frame.stream);
  if (!c) return;
  if (frame.type === FRAME_DATA) c.writer.write(frame.payload.slice());
  else if (frame.type === FRAME_CLOSE) dropConn(n, frame.stream, false);
}

export function tunnelClose(ws: ServerWebSocket<TunnelSocketData>): void {
  const n = live.get(ws.data.node);
  if (n && n.ws === ws) {
    teardown(n);
    console.log(`[trellis-gw] node ${n.name} disconnected`);
  }
}

/** 死连接清扫：node 静默超过 DEAD_AFTER_MS 就断开（node 侧会自己重连）。 */
export function startTunnelReaper(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    const now = Date.now();
    for (const n of live.values()) {
      if (now - n.lastSeen > DEAD_AFTER_MS) {
        try { n.ws.close(4008, "heartbeat timeout"); } catch { /* already closed */ }
        teardown(n);
      }
    }
  }, 10_000);
}

export const _forTests = { live };
