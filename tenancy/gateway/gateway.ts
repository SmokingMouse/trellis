import type { ServerWebSocket } from "bun";
import {
  addUser,
  authenticate,
  claimInvite,
  clearRateFailures,
  clearSessionCookie,
  disableUser,
  login,
  logout,
  rateLimited,
  recordRateFailure,
  registerUser,
  renewInvite,
  sessionCookie,
  type UserRole,
} from "./auth";
import { handleGatewayAPI } from "./api";
import { getGatewayDB } from "./db";
import { invitePage, loginPage, maintenancePage, nodeOfflinePage, registerPage, registerPendingPage } from "./pages";
import { provisionTenant } from "./orchestrator";
import { NODE_COOKIE, readCookie, responseHeaders, translatedCookie, upstreamHeaders } from "./proxy-util";
import { getTenant, type Tenant } from "./tenants";
import { TUNNEL_PATH } from "../../lib/hub-tunnel";
import {
  addNode,
  authenticateNode,
  listNodes,
  liveNode,
  revokeNode,
  startTunnelReaper,
  tunnelClose,
  tunnelMessage,
  tunnelOpen,
  type TunnelSocketData,
} from "./tunnel";
import type { SessionUser } from "./auth";
import { handleNodesAPI, handlePair, ownsNode } from "./nodes-api";
import { exportBlocked, parseVia, targetFor, type Target } from "./node-targets";
import { GATEWAY_PUSH_PATHS, handleGatewayPush, handleRelayPush } from "./push";

const PORT = Number(process.env.TRELLIS_GW_PORT) || 3200;
const argv = process.argv.slice(2);

function inviteURL(code: string): string {
  return `http://127.0.0.1:${PORT}/__gw/invite/${code}`;
}

async function userCLI(args: string[]): Promise<void> {
  const [command, name] = args;
  const db = getGatewayDB();
  if (command === "ls") {
    const rows = db.prepare("SELECT name,tenant,role,disabled,pass_hash IS NOT NULL AS claimed FROM users ORDER BY name").all();
    console.table(rows);
    return;
  }
  if (!name) throw new Error("usage: user add <name> --tenant <tenant> [--role admin|user] | user invite|disable <name> | user ls");
  if (command === "add") {
    const index = args.indexOf("--tenant");
    const tenant = index >= 0 ? args[index + 1] : undefined;
    if (!tenant) throw new Error("user add requires --tenant <tenant>");
    const roleIndex = args.indexOf("--role");
    const role = (roleIndex >= 0 ? args[roleIndex + 1] : "user") as UserRole;
    if (role !== "admin" && role !== "user") throw new Error("--role must be admin or user");
    const code = addUser(db, name, tenant, role);
    console.log(inviteURL(code));
  } else if (command === "invite") {
    const code = renewInvite(db, name);
    if (!code) throw new Error(`unknown user: ${name}`);
    console.log(inviteURL(code));
  } else if (command === "disable") {
    if (!disableUser(db, name)) throw new Error(`unknown user: ${name}`);
    console.log(`disabled ${name}`);
  } else {
    throw new Error(`unknown user command: ${command}`);
  }
}

async function nodeCLI(args: string[]): Promise<void> {
  const [command, name] = args;
  const db = getGatewayDB();
  if (command === "ls") {
    console.table(listNodes(db).map((row) => ({
      name: row.name, revoked: row.revoked, lastSeenAt: row.last_seen_at, online: Boolean(liveNode(row.name)),
    })));
    return;
  }
  if (!name) throw new Error("usage: node add <name> --owner <user> | node revoke <name> | node ls");
  if (command === "add") {
    const index = args.indexOf("--owner");
    const owner = index >= 0 ? args[index + 1] : undefined;
    const row = owner ? db.prepare("SELECT id FROM users WHERE name=?").get(owner) as { id: string } | null : null;
    if (!row) throw new Error("node add requires --owner <existing user>");
    const token = addNode(db, name, row.id);
    // 明文 token 只在这里出现一次；node 侧写进 TRELLIS_NODE_TOKEN。
    console.log(`TRELLIS_NODE_NAME=${name}\nTRELLIS_NODE_TOKEN=${token}`);
  } else if (command === "revoke") {
    if (!revokeNode(db, name)) throw new Error(`unknown node: ${name}`);
    console.log(`revoked ${name}`);
  } else {
    throw new Error(`unknown node command: ${command}`);
  }
}

// ── 多机路由 ────────────────────────────────────────────────────────────────
// 用户自己的 tenant 是默认 node；trellis_node cookie 选中一个**属于他的**远端
// node 时改路由过去。前端零改动：它看到的永远是同源 /api。
function resolveTarget(req: Request, user: SessionUser): Target {
  const selected = readCookie(req.headers.get("cookie"), NODE_COOKIE);
  if (selected && selected !== user.tenant) {
    const target = targetFor(getGatewayDB(), user, selected);
    if (target) return target;
  }
  return targetFor(getGatewayDB(), user, user.tenant);
}

function nodeCookie(name: string | null, isSecure: boolean): string {
  const attrs = `Path=/; HttpOnly; SameSite=Strict${isSecure ? "; Secure" : ""}`;
  return name ? `${NODE_COOKIE}=${name}; ${attrs}; Max-Age=31536000` : `${NODE_COOKIE}=; ${attrs}; Max-Age=0`;
}

async function fields(req: Request): Promise<Record<string, string>> {
  try {
    if ((req.headers.get("content-type") || "").includes("application/json")) {
      const body = await req.json() as Record<string, unknown>;
      return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, String(value ?? "")]));
    }
    const body = await req.formData();
    return Object.fromEntries([...body].map(([key, value]) => [key, String(value)]));
  } catch {
    return {};
  }
}

function secure(req: Request): boolean {
  return (req.headers.get("x-forwarded-proto") || "").toLowerCase() === "https";
}

function clientIP(req: Request): string {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    || req.headers.get("x-real-ip") || "unknown";
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

function unauthenticated(req: Request, url: URL): Response {
  if (url.pathname.startsWith("/__gw/api/")) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (req.method === "GET" && (req.headers.get("accept") || "").includes("text/html")) {
    return redirect(`/__gw/login?from=${encodeURIComponent(url.pathname + url.search)}`);
  }
  return new Response("Unauthorized", { status: 401 });
}

async function proxyHTTP(req: Request, url: URL, tenant: Tenant): Promise<Response> {
  // 这是「等到响应头」的超时，不只是建连：fetch 要等上游吐出响应头才 resolve。
  // 原来的 2s 会把冷启动 / 并发高峰下的 Next SSR 和静态资源一起掐掉，浏览器拿到
  // 维护页当 CSS/JS（2026-10-30 经 hub.home 实测：整页维护页 + 无样式页面）。
  // 上游真挂了时 ECONNREFUSED 是立刻失败的，用不着靠短超时来快速失败。
  const connectTimeoutMs = 30_000;
  const authority = `127.0.0.1:${tenant.hostPort}`;
  const controller = new AbortController();
  const abort = () => controller.abort(req.signal.reason);
  if (req.signal.aborted) abort();
  else req.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort("upstream connect timeout"), connectTimeoutMs);
  try {
    const upstream = await fetch(`http://${authority}${url.pathname}${url.search}`, {
      method: req.method,
      headers: (() => {
        const headers = upstreamHeaders(req.headers, authority, tenant.authToken);
        // 让远端实例知道「这次请求是经 hub 隧道来的」（设置页断开前据此确认）。
        if (tenant.kind === "remote") headers.set("x-trellis-hub-node", tenant.name);
        else headers.delete("x-trellis-hub-node");
        return headers;
      })(),
      body: req.body,
      redirect: "manual",
      signal: controller.signal,
      // @ts-expect-error Bun needs duplex for streaming request bodies.
      duplex: "half",
    });
    clearTimeout(timer);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders(upstream.headers),
    });
  } catch {
    clearTimeout(timer);
    req.signal.removeEventListener("abort", abort);
    return maintenancePage();
  }
}

type ProxySocketData = {
  kind: "proxy";
  target: string;
  cookie: string;
  protocols: string[];
  upstream?: WebSocket;
  queue: (string | Uint8Array)[];
};

type SocketData = ProxySocketData | TunnelSocketData;

function closeClient(ws: ServerWebSocket<ProxySocketData>, code = 1011, reason = "upstream closed") {
  try { ws.close(code, reason); } catch { /* already closed */ }
}

function startGateway(): void {
  const db = getGatewayDB();
  startTunnelReaper();
  Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: PORT,
    idleTimeout: 0,
    async fetch(req, server) {
      const url = new URL(req.url);
      // 远端 node 的隧道入口。不走用户 session：node 用自己的 Bearer token 认证。
      if (url.pathname === TUNNEL_PATH) {
        if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return new Response("Upgrade Required", { status: 426 });
        }
        const node = authenticateNode(db, req);
        if (!node) return new Response("Unauthorized", { status: 401 });
        if (server.upgrade(req, { data: { kind: "tunnel", node } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/__gw/pair") return handlePair(req, db, clientIP(req));
      // 机器 → hub 推送中继：机器凭证认证（relay-auth.ts），不走用户 session。
      if (url.pathname === "/__gw/relay/push") return handleRelayPush(req, db);
      if (url.pathname === "/__gw/login") {
        if (req.method === "GET") return loginPage();
        if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
        const body = await fields(req);
        const result = await login(db, body.name || "", body.password || "", clientIP(req));
        if (result.status !== 200) {
          if (result.status === 429) return new Response("尝试过于频繁", { status: 429, headers: { "retry-after": "60" } });
          return new Response("用户名或密码错误", { status: 401 });
        }
        return Response.json({ ok: true }, { headers: { "set-cookie": sessionCookie(result.token, secure(req)) } });
      }

      if (url.pathname === "/__gw/register") {
        if (req.method === "GET") return registerPage(url.searchParams.get("code") || "");
        if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
        const body = await fields(req);
        const name = (body.username || "").trim();
        const code = (body.code || "").trim();
        const password = body.password || "";
        const ip = clientIP(req);
        if (rateLimited("register", ip, name)) {
          return registerPage(code, "尝试过于频繁，请稍后再试", 429);
        }
        let message = "";
        let status = 400;
        if (!/^[a-z0-9-]{1,32}$/.test(name)) message = "用户名格式无效";
        else if (password.length < 8) message = "密码至少 8 个字符";
        else if (getTenant(name)) { message = "用户名已被占用"; status = 409; }
        if (message) {
          recordRateFailure("register", ip, name);
          return registerPage(code, message, status);
        }
        const result = await registerUser(db, code, name, password);
        if (result.status !== "ok") {
          recordRateFailure("register", ip, name);
          const error = result.status === "invalid_invite" ? "邀请码无效或已使用" : "用户名已被占用";
          return registerPage(code, error, result.status === "invalid_invite" ? 400 : 409);
        }
        clearRateFailures("register", ip, name);
        provisionTenant(name);
        return new Response(null, {
          status: 302,
          headers: {
            location: "/__gw/register/pending",
            "cache-control": "no-store",
            "set-cookie": sessionCookie(result.token, secure(req)),
          },
        });
      }

      const invite = url.pathname.match(/^\/__gw\/invite\/([^/]+)$/);
      if (invite) {
        const code = decodeURIComponent(invite[1]);
        const valid = db.prepare("SELECT 1 FROM users WHERE invite_code=? AND disabled=0").get(code);
        if (!valid) return new Response("邀请无效或已使用", { status: 404 });
        if (req.method === "GET") return invitePage(code);
        if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
        const token = await claimInvite(db, code, (await fields(req)).password || "");
        if (!token) return new Response("邀请无效，或密码少于 8 个字符", { status: 400 });
        return Response.json({ ok: true }, { headers: { "set-cookie": sessionCookie(token, secure(req)) } });
      }

      if (url.pathname === "/__gw/logout" && req.method === "POST") {
        logout(db, req);
        return Response.json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
      }

      const user = authenticate(db, req);
      if (!user) return unauthenticated(req, url);
      if (url.pathname === "/__gw/register/pending" && req.method === "GET") {
        return registerPendingPage();
      }
      if (url.pathname === "/__gw/api/nodes" || url.pathname.startsWith("/__gw/api/nodes/")) {
        return handleNodesAPI(req, url, user, db);
      }
      // 切 node：/__gw/go/<node>/<path> → 设 cookie，跳到该 node 上的 <path>。
      // 跨机汇总列表里的条目都指向这里，点一下就落到对的机器、对的会话。
      const go = url.pathname.match(/^\/__gw\/go\/([a-z0-9-]{1,64})(\/.*)?$/);
      if (go && req.method === "GET") {
        const [, name, rest] = go;
        const known = name === user.tenant || ownsNode(db, user, name);
        if (!known) return new Response("Unknown node", { status: 404 });
        // 只允许站内相对路径，防开放重定向（//evil.com）。
        const path = rest && !rest.startsWith("//") ? rest : "/";
        return new Response(null, {
          status: 302,
          headers: {
            location: `${path}${url.search}`,
            "cache-control": "no-store",
            "set-cookie": nodeCookie(name === user.tenant ? null : name, secure(req)),
          },
        });
      }
      if (url.pathname.startsWith("/__gw/via/")) {
        const via = parseVia(url.pathname);
        if (!via) return Response.json({ error: "bad via path" }, { status: 400 });
        const target = targetFor(db, user, via.name);
        if (!target) return Response.json({ error: "unknown node" }, { status: 404 });
        if ("offline" in target) return Response.json({ error: `机器 ${via.name} 离线`, offline: true }, { status: 503 });
        const blocked = exportBlocked(db, user, via.name, via.path);
        if (blocked) return blocked;
        const upstreamURL = new URL(url);
        upstreamURL.pathname = via.path;
        return proxyHTTP(req, upstreamURL, target.tenant);
      }
      if (url.pathname.startsWith("/__gw/api/")) {
        return handleGatewayAPI(req, url, user, db);
      }
      if (req.method === "GET" && url.pathname === "/login") return redirect("/");
      if ((req.method === "POST" || req.method === "DELETE") && url.pathname === "/api/login") {
        return new Response("Not Found", { status: 404 });
      }
      // 统一推送：订阅 / 公钥 / 测试由网关接住（网关 VAPID），见 push.ts。
      if (GATEWAY_PUSH_PATHS.has(url.pathname)) return handleGatewayPush(req, url, user, db);

      const target = resolveTarget(req, user);
      if (!target) return maintenancePage();
      if ("offline" in target) return nodeOfflinePage(target.offline, user.tenant);
      const { tenant } = target;
      const blocked = exportBlocked(db, user, tenant.name, url.pathname);
      if (blocked) return blocked;
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const protocols = (req.headers.get("sec-websocket-protocol") || "")
          .split(",").map((value) => value.trim()).filter(Boolean);
        const target = `ws://127.0.0.1:${tenant.hostPort}${url.pathname}${url.search}`;
        const cookie = translatedCookie(req.headers.get("cookie"), tenant.authToken);
        if (server.upgrade(req, { data: { kind: "proxy", target, cookie, protocols, queue: [] } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      return proxyHTTP(req, url, tenant);
    },
    websocket: {
      idleTimeout: 0,
      open(ws) {
        if (ws.data.kind === "tunnel") {
          tunnelOpen(db, ws as ServerWebSocket<TunnelSocketData>);
          return;
        }
        const data = ws.data;
        const client = ws as ServerWebSocket<ProxySocketData>;
        // Bun 的 WebSocket 客户端支持握手自定义 headers/protocols(bun-types WebSocketOptionsHeaders);
        // next build 的 tsc 走 DOM lib 看不到这个扩展签名,局部断言之。
        type BunWebSocketCtor = new (
          url: string,
          opts?: { headers?: Record<string, string>; protocols?: string[] },
        ) => WebSocket;
        const options = { headers: { cookie: data.cookie }, protocols: data.protocols };
        const upstream = new (WebSocket as unknown as BunWebSocketCtor)(data.target, options);
        upstream.binaryType = "arraybuffer";
        data.upstream = upstream;
        upstream.onopen = () => {
          for (const message of data.queue) upstream.send(message);
          data.queue.length = 0;
        };
        upstream.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) ws.send(new Uint8Array(event.data));
          else ws.send(event.data);
        };
        upstream.onclose = (event) => closeClient(client, event.code || 1000, event.reason);
        upstream.onerror = () => closeClient(client);
      },
      message(ws, message) {
        if (ws.data.kind === "tunnel") {
          tunnelMessage(db, ws as ServerWebSocket<TunnelSocketData>, message);
          return;
        }
        const data = ws.data;
        const frame = typeof message === "string" ? message : new Uint8Array(message);
        if (data.upstream?.readyState === WebSocket.OPEN) data.upstream.send(frame);
        else data.queue.push(frame);
      },
      close(ws, code, reason) {
        if (ws.data.kind === "tunnel") {
          tunnelClose(ws as ServerWebSocket<TunnelSocketData>);
          return;
        }
        try { ws.data.upstream?.close(code, reason); } catch { /* already closed */ }
      },
    },
  });
  console.log(`[trellis-gw] listening on 127.0.0.1:${PORT}`);
}

try {
  if (argv[0] === "user") await userCLI(argv.slice(1));
  else if (argv[0] === "node") await nodeCLI(argv.slice(1));
  else startGateway();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
