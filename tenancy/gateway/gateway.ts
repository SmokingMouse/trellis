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
import { invitePage, loginPage, maintenancePage, registerPage, registerPendingPage } from "./pages";
import { provisionTenant } from "./orchestrator";
import { responseHeaders, translatedCookie, upstreamHeaders } from "./proxy-util";
import { getTenant, type Tenant } from "./tenants";

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
  if (!name) throw new Error("usage: user add|invite|disable <name> [--tenant <tenant>] | user ls");
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
  const authority = `127.0.0.1:${tenant.hostPort}`;
  const controller = new AbortController();
  const abort = () => controller.abort(req.signal.reason);
  if (req.signal.aborted) abort();
  else req.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort("upstream connect timeout"), 2000);
  try {
    const upstream = await fetch(`http://${authority}${url.pathname}${url.search}`, {
      method: req.method,
      headers: upstreamHeaders(req.headers, authority, tenant.authToken),
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

type SocketData = {
  target: string;
  cookie: string;
  protocols: string[];
  upstream?: WebSocket;
  queue: (string | Uint8Array)[];
};

function closeClient(ws: ServerWebSocket<SocketData>, code = 1011, reason = "upstream closed") {
  try { ws.close(code, reason); } catch { /* already closed */ }
}

function startGateway(): void {
  const db = getGatewayDB();
  Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: PORT,
    idleTimeout: 0,
    async fetch(req, server) {
      const url = new URL(req.url);
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
      if (url.pathname.startsWith("/__gw/api/")) {
        return handleGatewayAPI(req, url, user, db);
      }
      if (req.method === "GET" && url.pathname === "/login") return redirect("/");
      if ((req.method === "POST" || req.method === "DELETE") && url.pathname === "/api/login") {
        return new Response("Not Found", { status: 404 });
      }

      const tenant = getTenant(user.tenant);
      if (!tenant) return maintenancePage();
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const protocols = (req.headers.get("sec-websocket-protocol") || "")
          .split(",").map((value) => value.trim()).filter(Boolean);
        const target = `ws://127.0.0.1:${tenant.hostPort}${url.pathname}${url.search}`;
        const cookie = translatedCookie(req.headers.get("cookie"), tenant.authToken);
        if (server.upgrade(req, { data: { target, cookie, protocols, queue: [] } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      return proxyHTTP(req, url, tenant);
    },
    websocket: {
      idleTimeout: 0,
      open(ws) {
        const data = ws.data;
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
        upstream.onclose = (event) => closeClient(ws, event.code || 1000, event.reason);
        upstream.onerror = () => closeClient(ws);
      },
      message(ws, message) {
        const data = ws.data;
        const frame = typeof message === "string" ? message : new Uint8Array(message);
        if (data.upstream?.readyState === WebSocket.OPEN) data.upstream.send(frame);
        else data.queue.push(frame);
      },
      close(ws, code, reason) {
        try { ws.data.upstream?.close(code, reason); } catch { /* already closed */ }
      },
    },
  });
  console.log(`[trellis-gw] listening on 127.0.0.1:${PORT}`);
}

try {
  if (argv[0] === "user") await userCLI(argv.slice(1));
  else startGateway();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
