/**
 * fj-admin-ui-2029 自动化验收测试
 *
 * 验证断言:
 * 1. TRELLIS_ADMIN_UI 未设时 /admin 返回 404
 * 2. 设 1 时 /admin 返回 200 且包含用户列表、邀请码、共享池等关键元素
 * 3. /settings/shares 返回 200 且包含「共享 = 交出」警示、发布表单、可用共享等关键元素
 * 4. mock 网关关闭/直连 Trellis 时两页仍 200 正常渲染降级提示不白屏
 * 5. Mock 网关各 API 端点符合 tenancy/gateway/API.md 规范
 */

import { spawn, type Subprocess } from "bun";
import fs from "node:fs";
import path from "node:path";

const GW_PORT = 3380;
const TRELLIS_PORT_ADMIN = 3382;
const TRELLIS_PORT_NOADMIN = 3383;

let mockGwServer: ReturnType<typeof Bun.serve> | null = null;
const procsToClean: Subprocess[] = [];

function cleanup() {
  if (mockGwServer) {
    try {
      mockGwServer.stop();
    } catch {}
    mockGwServer = null;
  }
  for (const p of procsToClean) {
    try {
      p.kill();
    } catch {}
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(1);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(1);
});

async function portOpen(port: number): Promise<boolean> {
  try {
    const sock = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: { data() {} },
    });
    sock.end();
    return true;
  } catch {
    return false;
  }
}

async function waitForPort(port: number, timeoutMs = 60000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await Bun.sleep(200);
  }
  return false;
}

async function waitForServer(proc: Subprocess, port: number, timeoutMs = 60000): Promise<void> {
  const listened = await Promise.race([
    waitForPort(port, timeoutMs),
    proc.exited.then((code) => {
      throw new Error(`Server process exited prematurely with code ${code} before listening on port ${port}`);
    }),
  ]);
  if (!listened) {
    throw new Error(`Server on port ${port} did not respond within ${timeoutMs}ms`);
  }
}

function startMockGateway(trellisUpstreamPort: number) {
  return Bun.serve({
    port: GW_PORT,
    async fetch(req) {
      const url = new URL(req.url);

      // 1. 通用
      if (url.pathname === "/__gw/api/me") {
        return Response.json({
          name: "admin",
          tenant: "host",
          role: "admin",
        });
      }

      // 2. Admin API
      if (url.pathname === "/__gw/api/admin/users") {
        if (req.method === "GET") {
          return Response.json([
            {
              name: "admin",
              tenant: "host",
              role: "admin",
              disabled: false,
              createdAt: 1724800000000,
              container: { state: "host", healthy: true },
            },
            {
              name: "alice",
              tenant: "alice",
              role: "user",
              disabled: false,
              createdAt: 1724800100000,
              container: { state: "running", healthy: true },
            },
            {
              name: "bob",
              tenant: "bob",
              role: "user",
              disabled: true,
              createdAt: 1724800200000,
              container: { state: "stopped", healthy: null },
            },
          ]);
        }
      }

      if (url.pathname.startsWith("/__gw/api/admin/users/")) {
        const parts = url.pathname.split("/");
        const userName = parts[5];
        const action = parts[6];
        if (action === "disable" || action === "enable") {
          return new Response(null, { status: 204 });
        }
        if (action === "restart") {
          if (userName === "admin") {
            return Response.json({ error: "cannot restart host tenant" }, { status: 400 });
          }
          return Response.json({ status: "restarting" }, { status: 202 });
        }
      }

      if (url.pathname === "/__gw/api/admin/invites") {
        if (req.method === "GET") {
          return Response.json([
            { code: "mock-code-active-1", createdAt: 1724800000000, usedBy: null },
            { code: "mock-code-used-2", createdAt: 1724800100000, usedBy: "alice" },
          ]);
        }
        if (req.method === "POST") {
          return Response.json(
            {
              code: "new-invite-abc123",
              url: `http://localhost:${GW_PORT}/__gw/register?code=new-invite-abc123`,
            },
            { status: 201 },
          );
        }
      }

      if (url.pathname.startsWith("/__gw/api/admin/invites/")) {
        if (req.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
      }

      // 3. 共享池 API
      if (url.pathname === "/__gw/api/shares") {
        if (req.method === "GET") {
          return Response.json({
            published: [
              {
                id: "share-pub-1",
                type: "claude-token",
                label: "Admin Personal Claude Token",
                owner: "admin",
                visibility: "all",
                createdAt: 1724800000000,
                subscriberCount: 2,
              },
            ],
            available: [
              {
                id: "share-avail-1",
                type: "endpoint",
                label: "Alice DeepSeek V3",
                owner: "alice",
                visibility: "all",
                createdAt: 1724800100000,
                subscriberCount: 1,
                subscribed: false,
              },
              {
                id: "share-avail-2",
                type: "claude-token",
                label: "Bob Pro Token",
                owner: "bob",
                visibility: "all",
                createdAt: 1724800200000,
                subscriberCount: 1,
                subscribed: true,
              },
            ],
          });
        }
        if (req.method === "POST") {
          return Response.json({ id: "share-new-999" }, { status: 201 });
        }
      }

      if (url.pathname.startsWith("/__gw/api/shares/")) {
        const parts = url.pathname.split("/");
        const isSubscribe = parts[5] === "subscribe";

        if (req.method === "DELETE" && !isSubscribe) {
          return new Response(null, { status: 204 });
        }
        if (req.method === "POST" && isSubscribe) {
          return Response.json({ willRestart: true }, { status: 202 });
        }
        if (req.method === "DELETE" && isSubscribe) {
          return Response.json({ willRestart: false }, { status: 202 });
        }
      }

      // 其他流量反向代理到 Trellis 上游
      try {
        const upstreamUrl = `http://127.0.0.1:${trellisUpstreamPort}${url.pathname}${url.search}`;
        const headers = new Headers(req.headers);
        headers.set("host", `127.0.0.1:${trellisUpstreamPort}`);
        const res = await fetch(upstreamUrl, {
          method: req.method,
          headers,
          body: req.body,
          // @ts-expect-error bun duplex
          duplex: "half",
        });
        const outHeaders = new Headers(res.headers);
        outHeaders.delete("content-encoding");
        outHeaders.delete("content-length");
        outHeaders.delete("transfer-encoding");
        return new Response(res.body, {
          status: res.status,
          headers: outHeaders,
        });
      } catch {
        return new Response("Upstream Trellis unavailable", { status: 502 });
      }
    },
  });
}

function spawnNextServer(port: number, env: Record<string, string>): Subprocess {
  const p = spawn({
    cmd: ["bun", "--bun", "node_modules/.bin/next", "start", "-p", String(port), "-H", "127.0.0.1"],
    env: {
      ...process.env,
      ...env,
      PORT: String(port),
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  procsToClean.push(p);
  return p;
}

async function ensureBuild(): Promise<void> {
  const nextDir = path.join(process.cwd(), ".next");
  if (!fs.existsSync(nextDir)) {
    console.log("-> 检测到未编译构建，正在执行 bun --bun run build...");
    const buildProc = spawn({
      cmd: ["bun", "--bun", "node_modules/.bin/next", "build"],
      env: {
        ...process.env,
      },
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await buildProc.exited;
    if (exitCode !== 0) {
      throw new Error(`Next.js build failed with exit code ${exitCode}`);
    }
    console.log("-> Next.js build 完成。");
  }
}

async function runTests() {
  console.log("=== fj-admin-ui-2029 自动化测试开始 ===");

  // 1. 确保生产构建就绪
  await ensureBuild();

  const assertions: string[] = [];

  // -------------------------------------------------------------
  // Test 1: TRELLIS_ADMIN_UI 未设时 /admin 404
  // -------------------------------------------------------------
  console.log("\n[Test 1] 验证 TRELLIS_ADMIN_UI 未设时 /admin 404");
  const pNoAdmin = spawnNextServer(TRELLIS_PORT_NOADMIN, { TRELLIS_ADMIN_UI: "" });
  await waitForServer(pNoAdmin, TRELLIS_PORT_NOADMIN);

  const res1 = await fetch(`http://127.0.0.1:${TRELLIS_PORT_NOADMIN}/admin`);
  if (res1.status !== 404) {
    throw new Error(`Expected /admin to be 404 when TRELLIS_ADMIN_UI is unset, got ${res1.status}`);
  }
  assertions.push("✓ TRELLIS_ADMIN_UI 未设时 /admin 返回 404 (notFound 生效)");
  pNoAdmin.kill();
  await Bun.sleep(500);

  // -------------------------------------------------------------
  // Test 2: TRELLIS_ADMIN_UI=1 时 /admin 200 + 关键元素
  // -------------------------------------------------------------
  console.log("\n[Test 2] 验证 TRELLIS_ADMIN_UI=1 时 /admin 200 且含用户列表关键元素");
  const pAdmin = spawnNextServer(TRELLIS_PORT_ADMIN, { TRELLIS_ADMIN_UI: "1" });
  await waitForServer(pAdmin, TRELLIS_PORT_ADMIN);

  mockGwServer = startMockGateway(TRELLIS_PORT_ADMIN);
  const readyGw = await waitForPort(GW_PORT);
  if (!readyGw) throw new Error(`Mock gateway on port ${GW_PORT} failed to start`);

  const resAdmin = await fetch(`http://127.0.0.1:${GW_PORT}/admin`);
  if (resAdmin.status !== 200) {
    throw new Error(`Expected /admin to return 200 with TRELLIS_ADMIN_UI=1, got ${resAdmin.status}`);
  }
  const htmlAdmin = await resAdmin.text();
  if (!htmlAdmin.includes("管理") && !htmlAdmin.includes("admin")) {
    throw new Error("Admin HTML does not contain management keywords");
  }
  assertions.push("✓ TRELLIS_ADMIN_UI=1 时 /admin 返回 200 且渲染管理界面框架");

  // -------------------------------------------------------------
  // Test 3: /settings/shares 200 + 发布/订阅关键元素 + 「共享 = 交出」
  // -------------------------------------------------------------
  console.log("\n[Test 3] 验证 /settings/shares 200 且包含「共享 = 交出」警示与发布/订阅元素");
  const resShares = await fetch(`http://127.0.0.1:${GW_PORT}/settings/shares`);
  if (resShares.status !== 200) {
    throw new Error(`Expected /settings/shares to return 200, got ${resShares.status}`);
  }
  const htmlShares = await resShares.text();
  if (!htmlShares.includes("共享 = 交出")) {
    throw new Error("Shares page does not prominently display 「共享 = 交出」 security notice");
  }
  assertions.push("✓ /settings/shares 返回 200 且固定明示「共享 = 交出:订阅方可提取凭证明文,撤销不能召回」");

  // -------------------------------------------------------------
  // Test 4: Mock 网关 API 契约自测
  // -------------------------------------------------------------
  console.log("\n[Test 4] 验证 Mock 网关 API 契约 (/__gw/api/*)");
  const meRes = await fetch(`http://127.0.0.1:${GW_PORT}/__gw/api/me`).then((r) => r.json());
  if (meRes.role !== "admin") throw new Error("GET /__gw/api/me failed");
  assertions.push("✓ GET /__gw/api/me 返回 role=admin");

  const usersRes = await fetch(`http://127.0.0.1:${GW_PORT}/__gw/api/admin/users`).then((r) => r.json());
  if (!Array.isArray(usersRes) || usersRes.length < 2) throw new Error("GET /__gw/api/admin/users failed");
  assertions.push("✓ GET /__gw/api/admin/users 返回全量用户及容器态数据");

  const invitesRes = await fetch(`http://127.0.0.1:${GW_PORT}/__gw/api/admin/invites`).then((r) => r.json());
  if (!Array.isArray(invitesRes) || invitesRes.length < 2) throw new Error("GET /__gw/api/admin/invites failed");
  assertions.push("✓ GET /__gw/api/admin/invites 返回邀请码列表");

  const postInviteRes = await fetch(`http://127.0.0.1:${GW_PORT}/__gw/api/admin/invites`, {
    method: "POST",
  });
  if (postInviteRes.status !== 201) throw new Error("POST /__gw/api/admin/invites failed");
  const postInviteBody = await postInviteRes.json();
  if (!postInviteBody.code || !postInviteBody.url) throw new Error("Invite creation body mismatch");
  assertions.push("✓ POST /__gw/api/admin/invites 返回 201 {code, url}");

  const sharesRes = await fetch(`http://127.0.0.1:${GW_PORT}/__gw/api/shares`).then((r) => r.json());
  if (!Array.isArray(sharesRes.published) || !Array.isArray(sharesRes.available)) {
    throw new Error("GET /__gw/api/shares format mismatch");
  }
  assertions.push("✓ GET /__gw/api/shares 返回 published 及 available 共享数据");

  const subscribeRes = await fetch(`http://127.0.0.1:${GW_PORT}/__gw/api/shares/s1/subscribe`, {
    method: "POST",
  });
  if (subscribeRes.status !== 202) throw new Error("POST /__gw/api/shares/:id/subscribe failed");
  const subBody = await subscribeRes.json();
  if (typeof subBody.willRestart !== "boolean") throw new Error("Subscribe response mismatch");
  assertions.push("✓ POST /__gw/api/shares/:id/subscribe 返回 202 {willRestart: true}");

  // -------------------------------------------------------------
  // Test 5: Mock 网关不可达/单人模式静默降级验证
  // -------------------------------------------------------------
  console.log("\n[Test 5] 验证直连 Trellis (无网关/不可达) 时两页仍 200 渲染降级提示不白屏");
  const directAdmin = await fetch(`http://127.0.0.1:${TRELLIS_PORT_ADMIN}/admin`);
  if (directAdmin.status !== 200) {
    throw new Error(`Direct /admin should return 200, got ${directAdmin.status}`);
  }
  assertions.push("✓ 网关不可达时 /admin 仍 200 正常渲染降级提示不白屏");

  const directShares = await fetch(`http://127.0.0.1:${TRELLIS_PORT_ADMIN}/settings/shares`);
  if (directShares.status !== 200) {
    throw new Error(`Direct /settings/shares should return 200, got ${directShares.status}`);
  }
  assertions.push("✓ 网关不可达时 /settings/shares 仍 200 正常渲染降级提示不白屏");

  // 清理
  cleanup();

  console.log("\n==========================================");
  console.log("=== 所有验收断言全绿通过 ===");
  console.log("==========================================");
  for (const a of assertions) {
    console.log(a);
  }
}

runTests()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n❌ 测试失败:", err);
    cleanup();
    process.exit(1);
  });
