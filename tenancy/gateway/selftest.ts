import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  injectEndpointConfig,
  injectEndpointEnv,
  removeEndpointConfig,
  removeEndpointEnv,
} from "./endpoint-share";

type Seen = { method: string; path: string; headers: Record<string, string> };
type MockData = { protocol: string | null };
const usedPorts = new Set<number>();

function candidate(): number {
  let port: number;
  do port = 41_000 + Math.floor(Math.random() * 1_000); while (usedPorts.has(port));
  return port;
}

function mockUpstream(id: string): { server: ReturnType<typeof Bun.serve<MockData>>; seen: Seen[] } {
  const seen: Seen[] = [];
  for (let tries = 0; tries < 100; tries++) {
    const port = candidate();
    try {
      const server = Bun.serve<MockData>({
        hostname: "127.0.0.1", port, idleTimeout: 0,
        fetch(req, server) {
          const url = new URL(req.url);
          const headers = Object.fromEntries(req.headers.entries());
          seen.push({ method: req.method, path: url.pathname, headers });
          if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
            const protocol = req.headers.get("sec-websocket-protocol");
            const responseHeaders = protocol
              ? { "sec-websocket-protocol": protocol.split(",")[0].trim() }
              : undefined;
            if (server.upgrade(req, { data: { protocol }, headers: responseHeaders })) return;
            return new Response("upgrade failed", { status: 400 });
          }
          if (url.pathname === "/echo-headers") return Response.json({ id, headers });
          if (url.pathname === "/__gate/health") return Response.json({ next: "ready" });
          if (url.pathname === "/login") return new Response("UPSTREAM_LOGIN_PAGE");
          if (url.pathname === "/sse") {
            const stream = new ReadableStream({
              async start(controller) {
                for (let i = 1; i <= 3; i++) {
                  controller.enqueue(new TextEncoder().encode(`data: ${id}-${i}\n\n`));
                  if (i < 3) await Bun.sleep(300);
                }
                controller.close();
              },
            });
            return new Response(stream, { headers: { "content-type": "text/event-stream" } });
          }
          return new Response(id);
        },
        websocket: {
          message(ws, message) { ws.send(message); },
        },
      });
      usedPorts.add(port);
      return { server, seen };
    } catch { /* occupied: retry */ }
  }
  throw new Error(`cannot allocate mock port for ${id}`);
}

function unusedPort(): number {
  for (let tries = 0; tries < 100; tries++) {
    const port = candidate();
    try {
      const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
      probe.stop(true);
      usedPorts.add(port);
      return port;
    } catch { /* occupied: retry */ }
  }
  throw new Error("cannot allocate gateway port");
}

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

async function test(number: number, name: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
    console.log(`PASS ${String(number).padStart(2, "0")} ${name}`);
  } catch (error) {
    console.error(`FAIL ${String(number).padStart(2, "0")} ${name}: ${error instanceof Error ? error.message : error}`);
    throw error;
  }
}

function cookie(response: Response): string {
  const value = response.headers.get("set-cookie");
  assert(value, "set-cookie header missing");
  assert(value.includes("SameSite=Strict"), "session cookie must be SameSite=Strict");
  return value.split(";", 1)[0];
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "trellis-gw-selftest-"));
  const tenantDir = join(root, "tenants");
  const envDir = join(root, "env");
  mkdirSync(tenantDir);
  mkdirSync(envDir);
  const mockA = mockUpstream("mock-a");
  const mockB = mockUpstream("mock-b");
  const gatewayPort = unusedPort();
  const deadPort = unusedPort();
  const gatewayFile = join(import.meta.dir, "gateway.ts");
  const dbFile = join(root, "gateway.db");
  const callsFile = join(root, "tenantctl-calls.jsonl");
  const fakeTenantctl = join(root, "fake-tenantctl.ts");
  writeFileSync(fakeTenantctl, `
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const input = await Bun.stdin.text();
appendFileSync(process.env.TRELLIS_GW_CALLS_LOG!, JSON.stringify({ args, input }) + "\\n");
const [command, name] = args;
if (command === "add") {
  await Bun.sleep(50);
  writeFileSync(join(process.env.TRELLIS_GW_TENANTS_DIR!, name + ".json"), JSON.stringify({
    name, container: "trellis-" + name, hostPort: Number(process.env.TRELLIS_GW_FAKE_PORT),
    authToken: "token-" + name, authPass: "pass", image: "fake", createdAt: new Date().toISOString(),
  }));
} else if (command === "inspect") {
  console.log(JSON.stringify(name === "maint"
    ? { state: "stopped", healthy: false }
    : { state: "running", healthy: true }));
} else if (command === "creds-share") {
  mkdirSync(process.env.TRELLIS_GW_ENV_DIR!, { recursive: true });
  const path = join(process.env.TRELLIS_GW_ENV_DIR!, name + ".env");
  const lines = (existsSync(path) ? readFileSync(path, "utf8") : "TRELLIS_AUTH_TOKEN=fake\\n")
    .split("\\n").filter((line) => line && !line.startsWith("CLAUDE_CODE_OAUTH_TOKEN="));
  if (args.includes("--claude-token-stdin")) lines.push("CLAUDE_CODE_OAUTH_TOKEN=" + input.trim());
  writeFileSync(path, lines.join("\\n") + "\\n", { mode: 0o600 });
} else if (command === "endpoint-share" || command === "restart") {
  // The call log is the observable; endpoint file mutation is unit-tested in-process below.
} else {
  console.error("unknown fake tenantctl command: " + command);
  process.exitCode = 1;
}
`);

  // Reproduce an一期 database exactly: migration must add role and all new tables in place.
  const legacy = new Database(dbFile);
  legacy.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, pass_hash TEXT,
      invite_code TEXT, tenant TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER
    );
  `);
  legacy.close();
  const env = {
    ...process.env,
    TRELLIS_GW_PORT: String(gatewayPort),
    TRELLIS_GW_DB: dbFile,
    TRELLIS_GW_TENANTS_DIR: tenantDir,
    TRELLIS_GW_ENV_DIR: envDir,
    TRELLIS_GW_CALLS_LOG: callsFile,
    TRELLIS_GW_FAKE_PORT: String(mockB.server.port!),
    TRELLIS_GW_TENANTCTL: `bun ${fakeTenantctl}`,
  };
  const tenant = (name: string, port: number, authToken: string, host = false) =>
    writeFileSync(join(tenantDir, `${name}.json`), JSON.stringify({
      name, hostPort: port, authToken, ...(host ? {} : { container: `trellis-${name}` }),
    }));
  // Bun.serve().port 类型是 number | undefined;listen 成功后必有值
  tenant("alice", mockA.server.port!, "token-alice");
  tenant("bob", mockB.server.port!, "token-bob");
  tenant("maint", deadPort, "token-maint");
  tenant("host-admin", mockA.server.port!, "token-admin", true);

  const gateway = Bun.spawn({
    cmd: ["bun", gatewayFile], env, stdout: "pipe", stderr: "pipe",
  });
  const base = `http://127.0.0.1:${gatewayPort}`;
  const runCLI = async (...args: string[]) => {
    const child = Bun.spawn({ cmd: ["bun", gatewayFile, ...args], env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    assert(code === 0, `CLI ${args.join(" ")} failed: ${err}`);
    return out.trim();
  };
  const claim = async (
    name: string,
    target: string,
    password: string,
    renew = false,
    role: "admin" | "user" = "user",
  ) => {
    const added = await runCLI("user", "add", name, "--tenant", target, "--role", role);
    assert(added.includes("/__gw/invite/"), "user add did not print invite URL");
    const output = renew ? await runCLI("user", "invite", name) : added;
    const code = output.split("/__gw/invite/")[1];
    const page = await fetch(`${base}/__gw/invite/${code}`);
    assert(page.status === 200 && (await page.text()).includes("password"), "invite page unavailable");
    const response = await fetch(`${base}/__gw/invite/${code}`, {
      method: "POST", body: new URLSearchParams({ password }), redirect: "manual",
    });
    assert(response.status === 200, `claim returned ${response.status}`);
    return cookie(response);
  };
  const api = (session: string, path: string, init: RequestInit = {}) => fetch(`${base}${path}`, {
    ...init,
    headers: { cookie: session, ...(init.headers || {}) },
  });
  const jsonPost = (session: string, path: string, body: unknown) => api(session, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const calls = (): Array<{ args: string[]; input: string }> => existsSync(callsFile)
    ? readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];

  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { ready = (await fetch(`${base}/__gw/login`)).status === 200; } catch { /* starting */ }
      if (ready) break;
      await Bun.sleep(100);
    }
    if (!ready) {
      const err = await new Response(gateway.stderr).text();
      throw new Error(`gateway did not start: ${err}`);
    }

    await test(1, "unauthenticated HTML redirect", async () => {
      const response = await fetch(`${base}/`, { headers: { accept: "text/html" }, redirect: "manual" });
      assert(response.status === 302, `wanted 302, got ${response.status}`);
      assert(response.headers.get("location")?.startsWith("/__gw/login"), "wrong login redirect");
    });

    await test(2, "unauthenticated API is 401", async () => {
      assert((await fetch(`${base}/api/sessions`)).status === 401, "API did not return 401");
    });

    let aliceCookie = "";
    await test(3, "user add + invite claim", async () => {
      aliceCookie = await claim("alice", "alice", "alice-pass", true);
    });

    await test(4, "login and per-IP/user rate limit", async () => {
      const good = await fetch(`${base}/__gw/login`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "alice", password: "alice-pass" }),
      });
      assert(good.status === 200, `correct login returned ${good.status}`);
      aliceCookie = cookie(good);
      for (let attempt = 1; attempt <= 5; attempt++) {
        const bad = await fetch(`${base}/__gw/login`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "alice", password: "wrong-pass" }),
        });
        assert(bad.status === 401, `bad attempt ${attempt} returned ${bad.status}`);
      }
      const limited = await fetch(`${base}/__gw/login`, {
        method: "POST", body: new URLSearchParams({ name: "alice", password: "wrong-pass" }),
      });
      assert(limited.status === 429, `sixth attempt returned ${limited.status}`);
    });

    await test(5, "gateway and forged upstream cookies are replaced", async () => {
      const response = await fetch(`${base}/echo-headers`, {
        headers: { cookie: `${aliceCookie}; trellis_auth=evil` },
      });
      const body = await response.json() as { headers: Record<string, string> };
      assert(body.headers.cookie === "trellis_auth=token-alice", `upstream cookie was ${body.headers.cookie}`);
    });

    await test(6, "Host and x-forwarded-host are rewritten", async () => {
      const response = await fetch(`${base}/echo-headers`, { headers: { cookie: aliceCookie } });
      const body = await response.json() as { headers: Record<string, string> };
      assert(body.headers.host === `127.0.0.1:${mockA.server.port}`, `upstream Host was ${body.headers.host}`);
      assert(body.headers["x-forwarded-host"] === `127.0.0.1:${gatewayPort}`, "original Host was not forwarded");
    });

    let bobCookie = "";
    await test(7, "users route to distinct tenants", async () => {
      bobCookie = await claim("bob", "bob", "bob-password");
      const alice = await (await fetch(`${base}/echo-headers`, { headers: { cookie: aliceCookie } })).json() as any;
      const bob = await (await fetch(`${base}/echo-headers`, { headers: { cookie: bobCookie } })).json() as any;
      assert(alice.id === "mock-a" && alice.headers.cookie === "trellis_auth=token-alice", "alice misrouted");
      assert(bob.id === "mock-b" && bob.headers.cookie === "trellis_auth=token-bob", "bob misrouted");
    });

    await test(8, "SSE remains incremental", async () => {
      const response = await fetch(`${base}/sse`, { headers: { cookie: bobCookie } });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const arrivals: number[] = [];
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        while (buffer.includes("\n\n")) {
          arrivals.push(Date.now());
          buffer = buffer.slice(buffer.indexOf("\n\n") + 2);
        }
      }
      assert(arrivals.length === 3, `received ${arrivals.length} events`);
      assert(arrivals[1] - arrivals[0] > 100 && arrivals[2] - arrivals[1] > 100, `events were buffered: ${arrivals}`);
    });

    await test(9, "WebSocket text/binary frames and protocol pass through", async () => {
      const received: (string | Uint8Array)[] = [];
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("WebSocket timeout")), 5000);
        // Bun WS 客户端的 headers/protocols 扩展签名,DOM lib 看不到(同 gateway.ts)
        type BunWebSocketCtor = new (
          url: string,
          opts?: { headers?: Record<string, string>; protocols?: string[] },
        ) => WebSocket;
        const ws = new (WebSocket as unknown as BunWebSocketCtor)(`${base.replace("http", "ws")}/term`, {
          headers: { cookie: aliceCookie }, protocols: ["echo.v1"],
        });
        ws.binaryType = "arraybuffer";
        ws.onopen = () => { ws.send("one"); ws.send(new Uint8Array([0, 1, 255])); ws.send("three"); };
        ws.onmessage = (event) => {
          received.push(event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data);
          if (received.length === 3) { clearTimeout(timeout); ws.close(); resolve(); }
        };
        ws.onerror = () => { clearTimeout(timeout); reject(new Error("WebSocket error")); };
      });
      assert(received[0] === "one" && received[2] === "three", "text frames changed");
      assert(received[1] instanceof Uint8Array && received[1].join(",") === "0,1,255", "binary frame changed");
      const handshake = mockA.seen.findLast((item) => item.path === "/term");
      assert(handshake?.headers["sec-websocket-protocol"] === "echo.v1", "subprotocol not forwarded");
      assert(handshake.headers.cookie === "trellis_auth=token-alice", "WS cookie not translated");
    });

    await test(10, "container login routes are intercepted", async () => {
      const before = mockA.seen.length;
      const get = await fetch(`${base}/login`, { headers: { cookie: aliceCookie }, redirect: "manual" });
      const post = await fetch(`${base}/api/login`, { method: "POST", headers: { cookie: aliceCookie } });
      assert(get.status === 302 && get.headers.get("location") === "/", "GET /login not intercepted");
      assert(post.status === 404, "POST /api/login not hidden");
      assert(mockA.seen.length === before, "intercepted route reached upstream");
    });

    let maintCookie = "";
    await test(11, "unavailable tenant gets maintenance page", async () => {
      maintCookie = await claim("maint", "maint", "maint-pass");
      const response = await fetch(`${base}/`, { headers: { cookie: maintCookie, accept: "text/html" } });
      assert(response.status === 200 && (await response.text()).includes("维护"), "maintenance page missing");
    });

    await test(12, "disabled user sessions stop immediately", async () => {
      await runCLI("user", "disable", "alice");
      const response = await fetch(`${base}/api/sessions`, { headers: { cookie: aliceCookie } });
      assert(response.status === 401, `disabled session returned ${response.status}`);
    });

    let adminCookie = "";
    await test(13, "legacy DB migration + role authorization", async () => {
      adminCookie = await claim("admin", "host-admin", "admin-password", false, "admin");
      const me = await (await api(adminCookie, "/__gw/api/me")).json() as Record<string, unknown>;
      assert(me.name === "admin" && me.tenant === "host-admin" && me.role === "admin", "admin /me shape wrong");
      const forbidden = await api(bobCookie, "/__gw/api/admin/users");
      assert(forbidden.status === 403 && (await forbidden.json() as any).error === "forbidden", "user crossed admin role gate");
      const anonymous = await fetch(`${base}/__gw/api/me`);
      assert(anonymous.status === 401 && (await anonymous.json() as any).error === "unauthenticated", "API 401 is not JSON");

      const migrated = new Database(dbFile);
      const role = migrated.prepare("SELECT dflt_value FROM pragma_table_info('users') WHERE name='role'").get() as { dflt_value: string } | null;
      const tables = new Set((migrated.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
      migrated.close();
      assert(role?.dflt_value === "'user'", `role migration default was ${role?.dflt_value}`);
      assert(tables.has("invites") && tables.has("shares") && tables.has("share_subscriptions"), "new tables missing after migration");
      assert((statSync(dbFile).mode & 0o777) === 0o600, "gateway.db is not 0600");
    });

    const createInvite = async (): Promise<{ code: string; url: string }> => {
      const response = await api(adminCookie, "/__gw/api/admin/invites", { method: "POST" });
      assert(response.status === 201, `create invite returned ${response.status}`);
      return response.json() as Promise<{ code: string; url: string }>;
    };

    await test(14, "admin invite create/list/delete", async () => {
      const invite = await createInvite();
      assert(invite.url === `${base}/__gw/register?code=${invite.code}`, `invite URL was ${invite.url}`);
      const listed = await (await api(adminCookie, "/__gw/api/admin/invites")).json() as any[];
      assert(listed.some((item) => item.code === invite.code && item.usedBy === null), "new invite absent from list");
      const removed = await api(adminCookie, `/__gw/api/admin/invites/${invite.code}`, { method: "DELETE" });
      assert(removed.status === 204, `delete invite returned ${removed.status}`);
    });

    let carolCookie = "";
    await test(15, "self-registration success/bad code/duplicate username", async () => {
      const bad = await fetch(`${base}/__gw/register`, {
        method: "POST",
        body: new URLSearchParams({ code: "bad-code", username: "badreg", password: "good-password" }),
        redirect: "manual",
      });
      assert(bad.status === 400 && (await bad.text()).includes("邀请码无效"), "bad invite was accepted");

      const invite = await createInvite();
      const page = await fetch(`${base}/__gw/register?code=${invite.code}`);
      assert(page.status === 200 && (await page.text()).includes(invite.code), "register page did not prefill code");
      const registered = await fetch(`${base}/__gw/register`, {
        method: "POST",
        body: new URLSearchParams({ code: invite.code, username: "carol", password: "carol-password" }),
        redirect: "manual",
      });
      assert(registered.status === 302 && registered.headers.get("location") === "/__gw/register/pending", "register did not redirect pending");
      carolCookie = cookie(registered);
      const pending = await api(carolCookie, "/__gw/register/pending");
      assert(pending.status === 200 && (await pending.text()).includes("准备中"), "pending page missing");

      let state = "";
      for (let attempt = 0; attempt < 50; attempt++) {
        const status = await (await api(carolCookie, "/__gw/api/register/status")).json() as { state: string };
        state = status.state;
        if (state === "ready") break;
        await Bun.sleep(20);
      }
      assert(state === "ready", `registered tenant stayed ${state}`);
      assert(calls().some((call) => call.args.join(" ") === "add carol"), "tenantctl add carol not spawned");

      const duplicateInvite = await createInvite();
      const duplicate = await fetch(`${base}/__gw/register`, {
        method: "POST",
        body: new URLSearchParams({ code: duplicateInvite.code, username: "carol", password: "another-password" }),
        redirect: "manual",
      });
      assert(duplicate.status === 409, `duplicate username returned ${duplicate.status}`);
      assert((await api(adminCookie, `/__gw/api/admin/invites/${duplicateInvite.code}`, { method: "DELETE" })).status === 204, "duplicate attempt consumed invite");
      assert((await api(adminCookie, `/__gw/api/admin/invites/${invite.code}`, { method: "DELETE" })).status === 409, "used invite was deletable");
    });

    await test(16, "registration rate limit", async () => {
      for (let attempt = 1; attempt <= 5; attempt++) {
        const response = await fetch(`${base}/__gw/register`, {
          method: "POST",
          body: new URLSearchParams({ code: "always-bad", username: "throttled", password: "good-password" }),
        });
        assert(response.status === 400, `bad registration ${attempt} returned ${response.status}`);
      }
      const limited = await fetch(`${base}/__gw/register`, {
        method: "POST",
        body: new URLSearchParams({ code: "always-bad", username: "throttled", password: "good-password" }),
      });
      assert(limited.status === 429, `sixth registration returned ${limited.status}`);
    });

    await test(17, "admin users/disable/enable/restart", async () => {
      const users = await (await api(adminCookie, "/__gw/api/admin/users")).json() as any[];
      const host = users.find((item) => item.name === "admin");
      const carol = users.find((item) => item.name === "carol");
      assert(host?.container.state === "host" && host.container.healthy === true, "host container state wrong");
      assert(carol?.role === "user" && carol.container.state === "running", "registered user state wrong");

      assert((await api(adminCookie, "/__gw/api/admin/users/bob/disable", { method: "POST" })).status === 204, "disable failed");
      assert((await api(bobCookie, "/__gw/api/me")).status === 401, "disabled session remained valid");
      assert((await api(adminCookie, "/__gw/api/admin/users/bob/enable", { method: "POST" })).status === 204, "enable failed");
      assert((await api(bobCookie, "/__gw/api/me")).status === 200, "enabled user session did not recover");
      assert((await api(adminCookie, "/__gw/api/admin/users/bob/restart", { method: "POST" })).status === 202, "restart failed");
      assert((await api(adminCookie, "/__gw/api/admin/users/admin/restart", { method: "POST" })).status === 400, "host restart was accepted");
      for (let attempt = 0; attempt < 20 && !calls().some((call) => call.args.join(" ") === "restart bob"); attempt++) {
        await Bun.sleep(10);
      }
      assert(calls().some((call) => call.args.join(" ") === "restart bob"), "tenantctl restart bob not spawned");
    });

    const publish = async (session: string, body: unknown): Promise<string> => {
      const response = await jsonPost(session, "/__gw/api/shares", body);
      if (response.status !== 201) {
        throw new Error(`publish returned ${response.status}: ${await response.text()}`);
      }
      return ((await response.json()) as { id: string }).id;
    };

    let tokenOne = "";
    await test(18, "share CRUD and viewer visibility", async () => {
      tokenOne = await publish(bobCookie, {
        type: "claude-token", label: "Bob token", payload: { token: "secret-one" }, visibility: ["carol"],
      });
      const ownerText = await (await api(bobCookie, "/__gw/api/shares")).text();
      assert(ownerText.includes(tokenOne) && !ownerText.includes("secret-one") && !ownerText.includes("payload"), "share payload leaked to owner");
      const carol = await (await api(carolCookie, "/__gw/api/shares")).json() as any;
      const available = carol.available.find((item: any) => item.id === tokenOne);
      assert(available?.owner === "bob" && available.subscribed === false, "visible share missing");
      const admin = await (await api(adminCookie, "/__gw/api/shares")).json() as any;
      assert(!admin.available.some((item: any) => item.id === tokenOne), "private share visible to wrong user");
      assert((await api(carolCookie, `/__gw/api/shares/${tokenOne}`, { method: "DELETE" })).status === 404, "non-owner deleted share");
      assert((await api(adminCookie, "/__gw/api/admin/users/bob/disable", { method: "POST" })).status === 204, "owner disable failed");
      const hidden = await (await api(carolCookie, "/__gw/api/shares")).json() as any;
      assert(!hidden.available.some((item: any) => item.id === tokenOne), "disabled owner's share stayed available");
      assert((await api(adminCookie, "/__gw/api/admin/users/bob/enable", { method: "POST" })).status === 204, "owner enable failed");
    });

    await test(19, "claude-token replacement and fake env orchestration", async () => {
      const hostToken = await publish(bobCookie, {
        type: "claude-token", label: "Host test", payload: { token: "host-secret" }, visibility: "all",
      });
      const hostSubscribe = await api(adminCookie, `/__gw/api/shares/${hostToken}/subscribe`, { method: "POST" });
      assert(hostSubscribe.status === 501, `host claude-token subscribe returned ${hostSubscribe.status}`);
      const stoppedSubscribe = await api(maintCookie, `/__gw/api/shares/${hostToken}/subscribe`, { method: "POST" });
      assert(stoppedSubscribe.status === 409, `stopped tenant subscribe returned ${stoppedSubscribe.status}`);

      const first = await api(carolCookie, `/__gw/api/shares/${tokenOne}/subscribe`, { method: "POST" });
      assert(first.status === 202 && (await first.json() as any).willRestart === true, "first token subscription failed");
      const envPath = join(envDir, "carol.env");
      assert(readFileSync(envPath, "utf8").includes("CLAUDE_CODE_OAUTH_TOKEN=secret-one"), "first token not written to env");

      const tokenTwo = await publish(adminCookie, {
        type: "claude-token", label: "Admin token", payload: { token: "secret-two" }, visibility: "all",
      });
      const second = await api(carolCookie, `/__gw/api/shares/${tokenTwo}/subscribe`, { method: "POST" });
      assert(second.status === 202 && (await second.json() as any).willRestart === true, "replacement token subscription failed");
      const replaced = readFileSync(envPath, "utf8");
      assert(replaced.includes("CLAUDE_CODE_OAUTH_TOKEN=secret-two") && !replaced.includes("secret-one"), "token env was not replaced");
      assert((statSync(envPath).mode & 0o777) === 0o600, "fake env file is not 0600");
      const perspective = await (await api(carolCookie, "/__gw/api/shares")).json() as any;
      assert(perspective.available.find((item: any) => item.id === tokenOne)?.subscribed === false, "old token subscription remained active");
      assert(perspective.available.find((item: any) => item.id === tokenTwo)?.subscribed === true, "new token subscription absent");

      const removed = await api(carolCookie, `/__gw/api/shares/${tokenTwo}/subscribe`, { method: "DELETE" });
      assert(removed.status === 202 && (await removed.json() as any).willRestart === true, "token unsubscribe failed");
      assert(!readFileSync(envPath, "utf8").includes("CLAUDE_CODE_OAUTH_TOKEN="), "token remained after unsubscribe");
      const tokenCalls = calls().filter((call) => call.args[0] === "creds-share" && call.args[1] === "carol");
      assert(tokenCalls.length === 3, `wanted 3 creds-share calls, got ${tokenCalls.length}`);
      assert(tokenCalls[0].input.trim() === "secret-one" && tokenCalls[1].input.trim() === "secret-two" && tokenCalls[2].args.includes("--revoke"), "creds-share sequence wrong");

      assert((await api(carolCookie, `/__gw/api/shares/${tokenOne}/subscribe`, { method: "POST" })).status === 202, "token cascade setup failed");
      assert((await api(bobCookie, `/__gw/api/shares/${tokenOne}`, { method: "DELETE" })).status === 204, "token cascade revoke failed");
      assert(!readFileSync(envPath, "utf8").includes("CLAUDE_CODE_OAUTH_TOKEN="), "token remained after owner revoke");
    });

    await test(20, "endpoints.yaml marker blocks are idempotent and reversible", async () => {
      const own = "default: own\nenv_file: ~/.config/sm/.env\nproviders:\n  mine:\n    api_key_env: MINE_KEY\n    models: [own]\n";
      const payload = {
        name: "shared", openai_url: "https://api.example.test/v1", api_key_env: "SHARED_KEY",
        apiKey: "endpoint-secret", models: ["shared-model"],
      };
      const once = injectEndpointConfig(own, "marker-test", payload);
      const twice = injectEndpointConfig(once.contents, "marker-test", payload);
      const occurrences = twice.contents.split("# fj-share:marker-test:begin").length - 1;
      assert(occurrences === 1 && twice.contents.includes("mine:") && twice.contents.includes("shared:"), "config injection was not idempotent");
      const envOnce = injectEndpointEnv("MINE_KEY=mine\n", "marker-test", "SHARED_KEY", "endpoint-secret");
      const envTwice = injectEndpointEnv(envOnce, "marker-test", "SHARED_KEY", "endpoint-secret");
      assert(envTwice.split("# fj-share:marker-test:begin").length - 1 === 1, "env injection duplicated marker");
      const cleanConfig = removeEndpointConfig(removeEndpointConfig(twice.contents, "marker-test").contents, "marker-test").contents;
      const cleanEnv = removeEndpointEnv(removeEndpointEnv(envTwice, "marker-test"), "marker-test");
      assert(cleanConfig.includes("mine:") && !cleanConfig.includes("shared:") && !cleanConfig.includes("fj-share"), "config revoke touched own provider or left marker");
      assert(cleanEnv === "MINE_KEY=mine\n", `env revoke changed own entry: ${JSON.stringify(cleanEnv)}`);
    });

    await test(21, "endpoint subscribe/unsubscribe and publish revoke cascade", async () => {
      const endpointId = await publish(bobCookie, {
        type: "endpoint",
        label: "Shared endpoint",
        payload: {
          name: "shared-api", anthropic_url: "https://api.example.test", api_key_env: "SHARED_API_KEY",
          apiKey: "endpoint-api-secret", models: ["model-a", "model-b"],
        },
        visibility: "all",
      });
      const before = calls().filter((call) => call.args[0] === "endpoint-share").length;
      const subscribe = await api(carolCookie, `/__gw/api/shares/${endpointId}/subscribe`, { method: "POST" });
      assert(subscribe.status === 202 && (await subscribe.json() as any).willRestart === false, "endpoint subscribe failed");
      const unsubscribe = await api(carolCookie, `/__gw/api/shares/${endpointId}/subscribe`, { method: "DELETE" });
      assert(unsubscribe.status === 202 && (await unsubscribe.json() as any).willRestart === false, "endpoint unsubscribe failed");
      assert((await api(carolCookie, `/__gw/api/shares/${endpointId}/subscribe`, { method: "POST" })).status === 202, "endpoint resubscribe failed");
      assert((await api(bobCookie, `/__gw/api/shares/${endpointId}`, { method: "DELETE" })).status === 204, "owner cascade revoke failed");
      const endpointCalls = calls().filter((call) => call.args[0] === "endpoint-share").slice(before);
      assert(endpointCalls.length === 4, `wanted set/revoke/set/revoke, got ${endpointCalls.length}`);
      assert(endpointCalls.map((call) => call.args.includes("--set") ? "set" : "revoke").join(",") === "set,revoke,set,revoke", "endpoint orchestration sequence wrong");
      const responseText = await (await api(carolCookie, "/__gw/api/shares")).text();
      assert(!responseText.includes(endpointId) && !responseText.includes("endpoint-api-secret"), "revoked endpoint remained visible or leaked payload");
    });

    console.log("SELFTEST_PASS");
  } finally {
    gateway.kill();
    await Promise.race([gateway.exited, Bun.sleep(1000)]);
    mockA.server.stop(true);
    mockB.server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

// 全局 watchdog:selftest 实测 ~5s 跑完;挂死时必须以非零退出,settle 的 verify 复跑不能被卡住
const watchdog = setTimeout(() => {
  console.error("SELFTEST_TIMEOUT");
  process.exit(1);
}, 120_000);

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => clearTimeout(watchdog));
