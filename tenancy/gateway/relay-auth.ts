// 机器 → hub 中继（/__gw/relay/*）的凭证校验：认出「哪台机器、属于哪个用户」。
// node 侧怎么带凭证见 lib/hub-relay-client.ts。
//
// - 远端 node：Authorization: Bearer <node token> + x-trellis-node: <名字>，与隧道握手
//   同一套（tunnel.ts authenticateNode）。机器名 = node 名，用户 = nodes.owner_id。
// - hub 本机的 tenant：Authorization: Bearer <tenant authToken>（tenants/<name>.json，
//   = 该实例的 TRELLIS_AUTH_TOKEN）。x-trellis-tenant 给了就只比对那一个 tenant，没给就在
//   全部 tenant 里按 token 找。机器名 = tenant 名，用户 = users.tenant 指向它的那个用户。
//
// 任何一步对不上一律 null（调用方回 401，不区分原因）。

import type { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import type { SessionUser } from "./auth";
import { getTenant, tenantsDir } from "./tenants";
import { authenticateNode } from "./tunnel";

export type RelayIdentity = { user: SessionUser; machine: string };

function sameSecret(a: string, b: string): boolean {
  // 先各自哈希成定长再比，长度不同也不泄漏时间差。
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

function tenantByToken(token: string, name: string | null): string | null {
  const names = name
    ? [name]
    : (() => {
        try {
          return readdirSync(tenantsDir()).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
        } catch {
          return [];
        }
      })();
  for (const n of names) {
    const tenant = getTenant(n);
    if (tenant && sameSecret(tenant.authToken, token)) return tenant.name;
  }
  return null;
}

export function authenticateRelay(db: Database, req: Request): RelayIdentity | null {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;

  if (req.headers.get("x-trellis-node")) {
    const node = authenticateNode(db, req);
    if (!node) return null;
    const user = db.prepare(`
      SELECT u.id,u.name,u.tenant,u.role FROM nodes n JOIN users u ON u.id=n.owner_id
      WHERE n.name=? AND n.revoked=0 AND u.disabled=0
    `).get(node) as SessionUser | null;
    return user ? { user, machine: node } : null;
  }

  const tenant = tenantByToken(token, req.headers.get("x-trellis-tenant"));
  if (!tenant) return null;
  // 一个 tenant 只归一个用户（注册 / user add 都是一人一 tenant）；万一多个取最早的。
  const user = db.prepare(
    "SELECT id,name,tenant,role FROM users WHERE tenant=? AND disabled=0 ORDER BY created_at LIMIT 1",
  ).get(tenant) as SessionUser | null;
  return user ? { user, machine: tenant } : null;
}
