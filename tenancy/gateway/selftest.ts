import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  mkdirSync(tenantDir);
  const mockA = mockUpstream("mock-a");
  const mockB = mockUpstream("mock-b");
  const gatewayPort = unusedPort();
  const deadPort = unusedPort();
  const gatewayFile = join(import.meta.dir, "gateway.ts");
  const env = {
    ...process.env,
    TRELLIS_GW_PORT: String(gatewayPort),
    TRELLIS_GW_DB: join(root, "gateway.db"),
    TRELLIS_GW_TENANTS_DIR: tenantDir,
  };
  const tenant = (name: string, port: number, authToken: string) =>
    writeFileSync(join(tenantDir, `${name}.json`), JSON.stringify({ name, hostPort: port, authToken }));
  // Bun.serve().port 类型是 number | undefined;listen 成功后必有值
  tenant("alice", mockA.server.port!, "token-alice");
  tenant("bob", mockB.server.port!, "token-bob");
  tenant("maint", deadPort, "token-maint");

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
  const claim = async (name: string, target: string, password: string, renew = false) => {
    const added = await runCLI("user", "add", name, "--tenant", target);
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
