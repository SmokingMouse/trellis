// 多机 node 的管理面（/__gw/api/nodes）与配对入口（/__gw/pair）。
// 运行期隧道见 tunnel.ts；node 侧的配置与兑换见 lib/hub-node-config.ts。

import type { Database } from "bun:sqlite";
import { encodeConnectionString } from "../../lib/hub-node-config";
import { clearRateFailures, rateLimited, recordRateFailure, type SessionUser } from "./auth";
import { requestOrigin } from "./api";
import { NODE_COOKIE, readCookie } from "./proxy-util";
import { getTenant } from "./tenants";
import { createPairing, listNodes, liveNode, redeemPairing, revokeNode } from "./tunnel";
import { nodePolicy, setNodePolicy } from "./node-targets";

function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

export function ownsNode(db: Database, user: SessionUser, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM nodes WHERE name=? AND owner_id=? AND revoked=0").get(name, user.id));
}

export function nodesFor(db: Database, user: SessionUser, req: Request) {
  const selected = readCookie(req.headers.get("cookie"), NODE_COOKIE);
  const remote = listNodes(db, user.id).filter((row) => !row.revoked);
  const current = selected && remote.some((row) => row.name === selected) ? selected : user.tenant;
  return [
    {
      name: user.tenant,
      kind: "home" as const,
      online: Boolean(getTenant(user.tenant)),
      current: current === user.tenant,
      version: null,
      lastSeenAt: null,
      connectedAt: null,
      policy: nodePolicy(db, user, user.tenant),
    },
    ...remote.map((row) => {
      const n = liveNode(row.name);
      return {
        name: row.name,
        kind: "remote" as const,
        online: Boolean(n),
        current: current === row.name,
        version: n?.version || null,
        lastSeenAt: row.last_seen_at,
        connectedAt: n?.connectedAt ?? null,
        policy: nodePolicy(db, user, row.name),
      };
    }),
  ];
}

/** hub 的对外地址：连接串里要写 node 能连到的那个，不是 127.0.0.1。 */
function hubOrigin(req: Request): string {
  return (process.env.TRELLIS_GW_PUBLIC_URL || requestOrigin(req)).replace(/\/+$/, "");
}

export async function handleNodesAPI(req: Request, url: URL, user: SessionUser, db: Database): Promise<Response> {
  if (url.pathname === "/__gw/api/nodes" && req.method === "GET") {
    return Response.json(nodesFor(db, user, req), { headers: { "cache-control": "no-store" } });
  }
  if (url.pathname === "/__gw/api/nodes" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (name === user.tenant) return error(409, "这个名字是本机实例，换一个");
    const result = createPairing(db, name, user.id);
    if ("error" in result) {
      return result.error === "invalid_name"
        ? error(400, "名称只能用小写字母、数字和连字符（1–32 个字符）")
        : error(409, "这个名字已被占用");
    }
    const hub = hubOrigin(req);
    return Response.json(
      {
        name,
        hub,
        expiresAt: result.expiresAt,
        connectionString: encodeConnectionString({ hub, name, ticket: result.ticket }),
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  }
  const one = url.pathname.match(/^\/__gw\/api\/nodes\/([a-z0-9-]{1,32})$/);
  // PATCH /__gw/api/nodes/<name> { shareOut?, acceptDispatch? }：改外流策略（本机也能改）。
  if (one && req.method === "PATCH") {
    const name = one[1];
    if (name !== user.tenant && !ownsNode(db, user, name)) return error(404, "not found");
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const patch: { shareOut?: boolean; acceptDispatch?: boolean } = {};
    if (typeof body?.shareOut === "boolean") patch.shareOut = body.shareOut;
    if (typeof body?.acceptDispatch === "boolean") patch.acceptDispatch = body.acceptDispatch;
    return Response.json({ name, policy: setNodePolicy(db, user, name, patch) });
  }
  if (one && req.method === "DELETE") {
    if (!ownsNode(db, user, one[1])) return error(404, "not found");
    revokeNode(db, one[1]);
    return new Response(null, { status: 204 });
  }
  return error(404, "not found");
}

/** node 拿票据换 token。不需要用户 session——票据本身就是凭证。 */
export async function handlePair(req: Request, db: Database, ip: string): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (rateLimited("pair", ip, "")) return error(429, "尝试过于频繁，请稍后再试");
  const body = (await req.json().catch(() => null)) as { ticket?: unknown; name?: unknown } | null;
  const ticket = typeof body?.ticket === "string" ? body.ticket : "";
  const name = typeof body?.name === "string" ? body.name : "";
  const token = ticket && name ? redeemPairing(db, ticket, name) : null;
  if (!token) {
    recordRateFailure("pair", ip, "");
    return error(410, "连接串无效、已过期或已被使用");
  }
  clearRateFailures("pair", ip, "");
  return Response.json({ name, token }, { headers: { "cache-control": "no-store" } });
}
