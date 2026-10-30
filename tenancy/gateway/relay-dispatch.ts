// 跨机派活的 hub 中继（P5）。A 机器的服务端拿自己的机器凭证（relay-auth.ts）调：
//
//   GET  /__gw/relay/machines                              → 同一用户名下的机器与策略
//   POST /__gw/relay/dispatch {machine,prompt,workspace?,provider?}
//        → 目标机器 POST /api/hub/dispatch-in → {machine,sessionId,nodeId,url}
//   GET  /__gw/relay/dispatch/<machine>/<sessionId>/<nodeId>
//        → 目标机器 GET /api/hub/dispatch-in/<sessionId>/<nodeId> → 该轮状态与回答
//
// 策略（node-targets.ts 的 nodePolicy）在这里一处校验，派发与取结果同一套：
//   来源 shareOut   —— prompt 会把来源机器上的上下文带出去；
//   目标 acceptDispatch —— 允许别的机器往这台派活（取回该轮回答是派活的一部分）。
// 来源与目标必须属于同一用户（targetFor 只认这个用户名下的机器）。
// 日志只记机器名、id、prompt 长度，不记 prompt 原文。

import type { Database } from "bun:sqlite";
import {
  DISPATCH_FROM_HEADER,
  ID_RE,
  MACHINE_NAME_RE,
  dispatchURL,
  parseDispatchInput,
  type RelayMachine,
} from "../../lib/hub-dispatch";
import { authenticateRelay, type RelayIdentity } from "./relay-auth";
import { machineNames, nodePolicy, targetFor } from "./node-targets";
import { liveNode } from "./tunnel";
import { getTenant, type Tenant } from "./tenants";

export const RELAY_DISPATCH_PREFIX = "/__gw/relay/dispatch";
export const RELAY_MACHINES_PATH = "/__gw/relay/machines";
/** 目标机器上的入口。只该由网关中继调用：cookie 路由与 via 直通一律拦掉（见 relayOnlyBlocked）。 */
export const DISPATCH_IN_PREFIX = "/api/hub/dispatch-in";

const UPSTREAM_TIMEOUT_MS = 30_000;

function fail(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

function log(msg: string): void {
  console.log(`[trellis-gw] relay ${msg}`);
}

/** cookie 路由 / via 直通访问 dispatch-in → 403。它绕过了来源校验与策略，只能经中继。 */
export function relayOnlyBlocked(pathname: string): Response | null {
  if (pathname !== DISPATCH_IN_PREFIX && !pathname.startsWith(`${DISPATCH_IN_PREFIX}/`)) return null;
  return fail(403, "这个接口只能经 hub 中继调用（/__gw/relay/dispatch）");
}

/** 来源 → 目标的派活许可。通过返回目标上游，否则返回带人话原因的错误响应。 */
export function checkDispatch(db: Database, caller: RelayIdentity, target: string): { tenant: Tenant } | Response {
  const { user, machine: source } = caller;
  if (!MACHINE_NAME_RE.test(target)) return fail(400, "机器名无效");
  if (target === source) return fail(400, `目标就是来源机器 ${source} 本身 —— 本机的活直接 trellisctl ask --new`);
  const t = targetFor(db, user, target);
  if (!t) return fail(404, `没有这台机器：${target}（不在你名下，trellisctl machines 看有哪些）`);
  if (!nodePolicy(db, user, source).shareOut) {
    return fail(403, `来源机器 ${source} 未允许内容外流（设置 → 机器互联 → 允许内容离开这台机器），派活会把它的上下文带出去`);
  }
  if (!nodePolicy(db, user, target).acceptDispatch) {
    return fail(403, `目标机器 ${target} 未允许被派活（设置 → 机器互联 → 允许别的机器往这台派活）`);
  }
  if ("offline" in t) return fail(503, `目标机器 ${target} 离线`);
  return t;
}

async function callUpstream(
  tenant: Tenant,
  method: string,
  path: string,
  source: string,
  body?: unknown,
): Promise<Response> {
  const headers = new Headers({
    cookie: `trellis_auth=${tenant.authToken}`,
    host: `127.0.0.1:${tenant.hostPort}`,
    [DISPATCH_FROM_HEADER]: source,
  });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (tenant.kind === "remote") headers.set("x-trellis-hub-node", tenant.name);
  try {
    const r = await fetch(`http://127.0.0.1:${tenant.hostPort}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      redirect: "manual",
    });
    const text = await r.text();
    let j: unknown = null;
    try {
      j = text ? JSON.parse(text) : null;
    } catch {
      /* 非 JSON：多半是旧版本实例没有这个路由（404 页）或维护页 */
    }
    if (!j || typeof j !== "object") {
      return fail(
        r.status === 404 ? 501 : 502,
        r.status === 404
          ? `目标机器 ${tenant.name} 的 trellis 版本太旧，还没有派活入口`
          : `目标机器 ${tenant.name} 回了非 JSON（HTTP ${r.status}）`,
      );
    }
    return Response.json(j, { status: r.status, headers: { "cache-control": "no-store" } });
  } catch (e) {
    return fail(502, `连不上目标机器 ${tenant.name}：${e instanceof Error ? e.message : String(e)}`);
  }
}

function listMachines(db: Database, caller: RelayIdentity): RelayMachine[] {
  const { user } = caller;
  return machineNames(db, user).map((name) => {
    const p = nodePolicy(db, user, name);
    return {
      name,
      self: name === caller.machine,
      online: name === user.tenant ? Boolean(getTenant(name)) : Boolean(liveNode(name)),
      shareOut: p.shareOut,
      acceptDispatch: p.acceptDispatch,
    };
  });
}

export async function handleRelayDispatch(req: Request, url: URL, db: Database): Promise<Response> {
  const caller = authenticateRelay(db, req);
  if (!caller) return fail(401, "中继凭证无效（远端机器看 ~/.trellis/hub-node.json，本机实例看 TRELLIS_AUTH_TOKEN）");

  if (url.pathname === RELAY_MACHINES_PATH) {
    if (req.method !== "GET") return fail(405, "Method Not Allowed");
    return Response.json({ self: caller.machine, machines: listMachines(db, caller) }, {
      headers: { "cache-control": "no-store" },
    });
  }

  if (url.pathname === RELAY_DISPATCH_PREFIX) {
    if (req.method !== "POST") return fail(405, "Method Not Allowed");
    const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const target = typeof raw?.machine === "string" ? raw.machine.trim() : "";
    const input = parseDispatchInput(raw);
    if (typeof input === "string") return fail(400, input);
    const allowed = checkDispatch(db, caller, target);
    if (allowed instanceof Response) {
      log(`dispatch ${caller.machine} → ${target} 拒绝 ${allowed.status}`);
      return allowed;
    }
    const res = await callUpstream(allowed.tenant, "POST", DISPATCH_IN_PREFIX, caller.machine, input);
    if (!res.ok) {
      log(`dispatch ${caller.machine} → ${target} 上游 ${res.status}`);
      return res;
    }
    const body = (await res.json()) as { sessionId?: unknown; nodeId?: unknown };
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const nodeId = typeof body.nodeId === "string" ? body.nodeId : "";
    if (!ID_RE.test(sessionId) || !ID_RE.test(nodeId)) return fail(502, `目标机器 ${target} 没回会话 id`);
    log(`dispatch ${caller.machine} → ${target} session=${sessionId} node=${nodeId} prompt=${input.prompt.length}字`);
    return Response.json(
      { machine: target, sessionId, nodeId, url: dispatchURL(target, sessionId, nodeId) },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  }

  const m = url.pathname.match(/^\/__gw\/relay\/dispatch\/([a-z0-9-]{1,64})\/([A-Za-z0-9_-]{1,80})\/([A-Za-z0-9_-]{1,80})$/);
  if (m) {
    if (req.method !== "GET") return fail(405, "Method Not Allowed");
    const [, target, sessionId, nodeId] = m;
    const allowed = checkDispatch(db, caller, target);
    if (allowed instanceof Response) return allowed;
    const res = await callUpstream(
      allowed.tenant,
      "GET",
      `${DISPATCH_IN_PREFIX}/${sessionId}/${nodeId}`,
      caller.machine,
    );
    if (!res.ok) return res;
    const body = (await res.json()) as Record<string, unknown>;
    return Response.json(
      { ...body, machine: target, sessionId, nodeId, url: dispatchURL(target, sessionId, nodeId) },
      { headers: { "cache-control": "no-store" } },
    );
  }

  return fail(404, "unknown relay path");
}
