import type { Database } from "bun:sqlite";
import { inviteCode, disableUser, enableUser, type SessionUser } from "./auth";
import { containerState, registrationStatus, restartTenant } from "./orchestrator";
import { getTenant } from "./tenants";

function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function requestOrigin(req: Request): string {
  const url = new URL(req.url);
  const proto = (req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "")).split(",")[0].trim();
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host).split(",")[0].trim();
  return `${proto}://${host}`;
}

export async function handleGatewayAPI(
  req: Request,
  url: URL,
  user: SessionUser,
  db: Database,
): Promise<Response> {
  if (url.pathname === "/__gw/api/me" && req.method === "GET") {
    return Response.json({ name: user.name, tenant: user.tenant, role: user.role });
  }
  if (url.pathname === "/__gw/api/register/status" && req.method === "GET") {
    return Response.json(registrationStatus(user.tenant));
  }
  if (!url.pathname.startsWith("/__gw/api/admin/")) return error(404, "not found");
  if (user.role !== "admin") return error(403, "forbidden");

  if (url.pathname === "/__gw/api/admin/users" && req.method === "GET") {
    const rows = db.prepare(
      "SELECT name,tenant,role,disabled,created_at AS createdAt FROM users ORDER BY name",
    ).all() as Array<{
      name: string; tenant: string; role: "admin" | "user"; disabled: number; createdAt: number;
    }>;
    const result = await Promise.all(rows.map(async (row) => ({
      ...row,
      disabled: Boolean(row.disabled),
      container: await containerState(row.tenant),
    })));
    return Response.json(result);
  }

  if (url.pathname === "/__gw/api/admin/invites" && req.method === "POST") {
    const code = inviteCode();
    db.prepare("INSERT INTO invites (code,created_at) VALUES (?,?)").run(code, Date.now());
    return Response.json(
      { code, url: `${requestOrigin(req)}/__gw/register?code=${encodeURIComponent(code)}` },
      { status: 201 },
    );
  }
  if (url.pathname === "/__gw/api/admin/invites" && req.method === "GET") {
    const rows = db.prepare(
      "SELECT code,created_at AS createdAt,used_by AS usedBy FROM invites ORDER BY created_at DESC",
    ).all();
    return Response.json(rows);
  }

  const inviteMatch = url.pathname.match(/^\/__gw\/api\/admin\/invites\/([^/]+)$/);
  if (inviteMatch && req.method === "DELETE") {
    const code = decodeURIComponent(inviteMatch[1]);
    const row = db.prepare("SELECT used_at FROM invites WHERE code=?").get(code) as { used_at: number | null } | null;
    if (!row) return error(404, "invite not found");
    if (row.used_at !== null) return error(409, "invite already used");
    db.prepare("DELETE FROM invites WHERE code=?").run(code);
    return new Response(null, { status: 204 });
  }

  const userMatch = url.pathname.match(/^\/__gw\/api\/admin\/users\/([^/]+)\/(disable|enable|restart)$/);
  if (userMatch && req.method === "POST") {
    const name = decodeURIComponent(userMatch[1]);
    const action = userMatch[2];
    if (action === "disable") {
      if (!disableUser(db, name)) return error(404, "user not found");
      return new Response(null, { status: 204 });
    }
    if (action === "enable") {
      if (!enableUser(db, name)) return error(404, "user not found");
      return new Response(null, { status: 204 });
    }
    const row = db.prepare("SELECT tenant FROM users WHERE name=?").get(name) as { tenant: string } | null;
    if (!row) return error(404, "user not found");
    const tenant = getTenant(row.tenant);
    if (!tenant) return error(404, "tenant not found");
    if (tenant.kind === "host") return error(400, "host tenant cannot be restarted");
    restartTenant(row.tenant);
    return new Response(null, { status: 202 });
  }

  return error(404, "not found");
}
