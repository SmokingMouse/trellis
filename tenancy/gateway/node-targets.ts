// 多机联动的底座：按名字找到某台机器的上游、每台机器的外流策略、/__gw/via 直通。
//
// - targetFor：cookie 路由（gateway.resolveTarget）与 via 直通共用的「名字 → 上游」解析，
//   只认属于这个用户的机器。
// - 外流策略（node_policies）：shareOut = 允许内容离开这台机器（会话导出、配置导出、
//   作为派活来源）；acceptDispatch = 允许别的机器往这台派活。本机默认全开，远端机器
//   默认全关（远端多是公司 devbox，数据不该默认流回家里），在设置 → 机器互联里改。
// - 约定：node 上所有「把内容带出本机」的接口都挂在 /api/export/ 下，网关对 shareOut
//   关闭的机器一律 403——不管请求走 cookie 路由还是 via 直通。

import type { Database } from "bun:sqlite";
import type { SessionUser } from "./auth";
import { ownsNode } from "./nodes-api";
import { getTenant, type Tenant } from "./tenants";
import { liveNode } from "./tunnel";

export type Target = { tenant: Tenant } | { offline: string } | null;

export const EXPORT_PREFIX = "/api/export/";

export function targetFor(db: Database, user: SessionUser, name: string): Target {
  if (name !== user.tenant) {
    if (!ownsNode(db, user, name)) return null;
    const n = liveNode(name);
    if (!n) return { offline: name };
    return { tenant: { name, hostPort: n.port, authToken: n.gateToken, kind: "remote" } };
  }
  const tenant = getTenant(user.tenant);
  return tenant ? { tenant } : null;
}

/** 这个用户名下的全部机器名（本机在前）。 */
export function machineNames(db: Database, user: SessionUser): string[] {
  const rows = db
    .prepare("SELECT name FROM nodes WHERE owner_id=? AND revoked=0 ORDER BY name")
    .all(user.id) as { name: string }[];
  return [user.tenant, ...rows.map((r) => r.name)];
}

// ── 外流策略 ────────────────────────────────────────────────────────────────

export type NodePolicy = { shareOut: boolean; acceptDispatch: boolean };

export function ensurePolicyTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS node_policies (
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      share_out INTEGER NOT NULL,
      accept_dispatch INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_id, name)
    );
  `);
}

export function defaultPolicy(user: SessionUser, name: string): NodePolicy {
  const home = name === user.tenant;
  return { shareOut: home, acceptDispatch: home };
}

export function nodePolicy(db: Database, user: SessionUser, name: string): NodePolicy {
  ensurePolicyTable(db);
  const row = db
    .prepare("SELECT share_out, accept_dispatch FROM node_policies WHERE owner_id=? AND name=?")
    .get(user.id, name) as { share_out: number; accept_dispatch: number } | null;
  if (!row) return defaultPolicy(user, name);
  return { shareOut: Boolean(row.share_out), acceptDispatch: Boolean(row.accept_dispatch) };
}

export function setNodePolicy(db: Database, user: SessionUser, name: string, patch: Partial<NodePolicy>): NodePolicy {
  const next = { ...nodePolicy(db, user, name), ...patch };
  db.prepare(
    `INSERT INTO node_policies (owner_id, name, share_out, accept_dispatch, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(owner_id, name) DO UPDATE SET share_out=excluded.share_out,
       accept_dispatch=excluded.accept_dispatch, updated_at=excluded.updated_at`,
  ).run(user.id, name, next.shareOut ? 1 : 0, next.acceptDispatch ? 1 : 0, Date.now());
  return next;
}

/** /api/export/* 且这台机器不允许外流 → 403 响应；否则 null。 */
export function exportBlocked(db: Database, user: SessionUser, name: string, pathname: string): Response | null {
  if (!pathname.startsWith(EXPORT_PREFIX)) return null;
  if (nodePolicy(db, user, name).shareOut) return null;
  return Response.json(
    { error: `机器 ${name} 未允许内容外流（设置 → 机器互联 → 允许内容离开这台机器）` },
    { status: 403 },
  );
}

// ── /__gw/via/<node>/<path> ─────────────────────────────────────────────────
// 不切 cookie、直接调某台机器的 /api。跨机汇总、会话接力、配置同步都在浏览器里经它
// 一次读 A 写 B。只放行 /api/ 前缀，其余（页面、静态资源）还是走 /__gw/go 整页切换。

export const VIA_RE = /^\/__gw\/via\/([a-z0-9-]{1,64})(\/.*)$/;

export function parseVia(pathname: string): { name: string; path: string } | null {
  const m = pathname.match(VIA_RE);
  if (!m) return null;
  const [, name, path] = m;
  if (!path.startsWith("/api/") || path.includes("/../") || path.includes("//")) return null;
  return { name, path };
}
