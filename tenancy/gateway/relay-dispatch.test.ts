import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGatewayDB } from "./db";
import { addUser, type SessionUser } from "./auth";
import { addNode, _forTests } from "./tunnel";
import { setNodePolicy } from "./node-targets";
import { authenticateRelay } from "./relay-auth";
import { handleRelayDispatch, relayOnlyBlocked } from "./relay-dispatch";
import { MAX_DISPATCH_PROMPT } from "../../lib/hub-dispatch";

// 跨机派活中继：凭证、同用户、来源 shareOut、目标 acceptDispatch 四道闸，以及放行后
// 确实打到对的上游（本机 tenant 用 tenant authToken、远端 node 用隧道的 gateToken）。

type Seen = { method: string; path: string; cookie: string | null; from: string | null; hubNode: string | null; body: unknown };

const db = openGatewayDB(":memory:");
const dir = mkdtempSync(join(tmpdir(), "relay-dispatch-"));
const prevTenantsDir = process.env.TRELLIS_GW_TENANTS_DIR;
let home: Server<undefined>;
let office: Server<undefined>;
const seen: Record<string, Seen[]> = { home: [], office: [] };
let me: SessionUser;
let officeToken = "";

function mockTrellis(name: "home" | "office"): Server<undefined> {
  return Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.json().catch(() => null) : null;
      seen[name].push({
        method: req.method,
        path: url.pathname,
        cookie: req.headers.get("cookie"),
        from: req.headers.get("x-trellis-dispatch-from"),
        hubNode: req.headers.get("x-trellis-hub-node"),
        body,
      });
      if (req.method === "POST" && url.pathname === "/api/hub/dispatch-in") {
        return Response.json({ sessionId: `s-${name}`, nodeId: `n-${name}` }, { status: 201 });
      }
      if (url.pathname === `/api/hub/dispatch-in/s-${name}/n-${name}`) {
        return Response.json({ status: "done", response: `answer from ${name}`, truncated: false, errorMessage: null, pendingTool: null });
      }
      return Response.json({ error: "nope" }, { status: 404 });
    },
  });
}

beforeAll(() => {
  process.env.TRELLIS_GW_TENANTS_DIR = dir;
  addUser(db, "admin", "host-admin", "admin");
  addUser(db, "other", "host-other", "user");
  const row = (n: string) => db.prepare("SELECT id,name,tenant,role FROM users WHERE name=?").get(n) as SessionUser;
  me = row("admin");
  officeToken = addNode(db, "office", me.id);
  addNode(db, "lab", row("other").id);

  home = mockTrellis("home");
  office = mockTrellis("office");
  writeFileSync(join(dir, "host-admin.json"), JSON.stringify({ name: "host-admin", hostPort: home.port, authToken: "tok-admin" }));
  writeFileSync(join(dir, "host-other.json"), JSON.stringify({ name: "host-other", hostPort: 1, authToken: "tok-other" }));
  // 假装 office 的隧道在线：路由只看 liveNode() 给的虚拟端口与 gateToken。
  _forTests.live.set("office", {
    name: "office",
    ownerId: me.id,
    port: office.port,
    gateToken: "gate-office",
    version: "test",
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    conns: new Map(),
  } as never);
});

afterAll(() => {
  _forTests.live.delete("office");
  home?.stop(true);
  office?.stop(true);
  rmSync(dir, { recursive: true, force: true });
  if (prevTenantsDir === undefined) delete process.env.TRELLIS_GW_TENANTS_DIR;
  else process.env.TRELLIS_GW_TENANTS_DIR = prevTenantsDir;
});

const asHome = { authorization: "Bearer tok-admin" };
const asOffice = () => ({ authorization: `Bearer ${officeToken}`, "x-trellis-node": "office" });

function relay(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
  const req = new Request(`http://hub${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleRelayDispatch(req, new URL(req.url), db);
}

const errorOf = async (r: Response) => ((await r.json()) as { error: string }).error;

test("authenticateRelay：node token / tenant token 认出机器与用户，错的一律 null", () => {
  const req = (h: Record<string, string>) => new Request("http://hub/__gw/relay/dispatch", { headers: h });
  expect(authenticateRelay(db, req(asOffice()))).toMatchObject({ machine: "office", user: { id: me.id } });
  expect(authenticateRelay(db, req({ authorization: "Bearer wrong", "x-trellis-node": "office" }))).toBeNull();
  expect(authenticateRelay(db, req(asHome))).toMatchObject({ machine: "host-admin", user: { id: me.id } });
  expect(authenticateRelay(db, req({ ...asHome, "x-trellis-tenant": "host-admin" }))?.machine).toBe("host-admin");
  // 拿自己的 token 冒充别人的 tenant 名
  expect(authenticateRelay(db, req({ ...asHome, "x-trellis-tenant": "host-other" }))).toBeNull();
  expect(authenticateRelay(db, req({ authorization: "Bearer nope" }))).toBeNull();
  expect(authenticateRelay(db, req({}))).toBeNull();
});

test("错 token → 401", async () => {
  const r = await relay("POST", "/__gw/relay/dispatch", { authorization: "Bearer nope" }, { machine: "office", prompt: "hi" });
  expect(r.status).toBe(401);
});

test("他人的机器 → 404，且不碰任何上游", async () => {
  const r = await relay("POST", "/__gw/relay/dispatch", asHome, { machine: "lab", prompt: "hi" });
  expect(r.status).toBe(404);
  expect(seen.office.length + seen.home.length).toBe(0);
});

test("目标 acceptDispatch=false（远端默认）→ 403 并说清原因", async () => {
  const r = await relay("POST", "/__gw/relay/dispatch", asHome, { machine: "office", prompt: "hi" });
  expect(r.status).toBe(403);
  expect(await errorOf(r)).toContain("未允许被派活");
  expect(seen.office.length).toBe(0);
});

test("来源 shareOut=false（远端默认）→ 403；取结果同样拦", async () => {
  const r = await relay("POST", "/__gw/relay/dispatch", asOffice(), { machine: "host-admin", prompt: "hi" });
  expect(r.status).toBe(403);
  expect(await errorOf(r)).toContain("未允许内容外流");
  const s = await relay("GET", "/__gw/relay/dispatch/host-admin/s-home/n-home", asOffice());
  expect(s.status).toBe(403);
  expect(seen.home.length).toBe(0);
});

test("prompt 超长 / 派给自己 → 400", async () => {
  setNodePolicy(db, me, "office", { acceptDispatch: true });
  const long = await relay("POST", "/__gw/relay/dispatch", asHome, { machine: "office", prompt: "x".repeat(MAX_DISPATCH_PROMPT + 1) });
  expect(long.status).toBe(400);
  const self = await relay("POST", "/__gw/relay/dispatch", asHome, { machine: "host-admin", prompt: "hi" });
  expect(self.status).toBe(400);
  expect(seen.office.length).toBe(0);
});

test("本机 → office：放行后打到 office 的隧道端口，带 gateToken 与来源名；取结果同路", async () => {
  const r = await relay("POST", "/__gw/relay/dispatch", asHome, { machine: "office", prompt: "跑测试", workspace: "/srv/proj" });
  expect(r.status).toBe(201);
  expect(await r.json()).toEqual({
    machine: "office",
    sessionId: "s-office",
    nodeId: "n-office",
    url: "/__gw/go/office/?session=s-office&node=n-office",
  });
  expect(seen.office[0]).toMatchObject({
    method: "POST",
    path: "/api/hub/dispatch-in",
    cookie: "trellis_auth=gate-office",
    from: "host-admin",
    hubNode: "office",
    body: { prompt: "跑测试", workspace: "/srv/proj", provider: null },
  });
  expect(seen.home.length).toBe(0);

  const s = await relay("GET", "/__gw/relay/dispatch/office/s-office/n-office", asHome);
  expect(s.status).toBe(200);
  expect(await s.json()).toMatchObject({ machine: "office", status: "done", response: "answer from office" });
  expect(seen.office[1]).toMatchObject({ method: "GET", path: "/api/hub/dispatch-in/s-office/n-office", from: "host-admin" });
});

test("office 开了 shareOut 后 → 本机：打到本机 tenant 端口，带 tenant authToken", async () => {
  setNodePolicy(db, me, "office", { shareOut: true });
  const r = await relay("POST", "/__gw/relay/dispatch", asOffice(), { machine: "host-admin", prompt: "hi" });
  expect(r.status).toBe(201);
  expect(seen.home[0]).toMatchObject({ path: "/api/hub/dispatch-in", cookie: "trellis_auth=tok-admin", from: "office", hubNode: null });
});

test("machines 列出同用户机器与策略；dispatch-in 不能经 cookie 路由 / via 直达", async () => {
  const r = await relay("GET", "/__gw/relay/machines", asHome);
  const j = (await r.json()) as { self: string; machines: { name: string; self: boolean; online: boolean; acceptDispatch: boolean }[] };
  expect(j.self).toBe("host-admin");
  expect(j.machines.map((m) => m.name)).toEqual(["host-admin", "office"]);
  expect(j.machines.find((m) => m.name === "office")).toMatchObject({ online: true, acceptDispatch: true, self: false });
  expect(relayOnlyBlocked("/api/hub/dispatch-in")?.status).toBe(403);
  expect(relayOnlyBlocked("/api/hub/dispatch-in/s/n")?.status).toBe(403);
  expect(relayOnlyBlocked("/api/hub/dispatch")).toBeNull();
});
