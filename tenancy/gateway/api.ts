import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { inviteCode, disableUser, enableUser, type SessionUser } from "./auth";
import { validateEndpointPayload } from "./endpoint-share";
import {
  applyShareInjection,
  containerState,
  OrchestrationError,
  registrationStatus,
  removeShareInjection,
  restartTenant,
  type ShareInjection,
} from "./orchestrator";
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

type ShareRow = {
  id: string;
  type: "claude-token" | "endpoint";
  label: string;
  owner_id: string;
  owner: string;
  owner_disabled: number;
  payload: string;
  visibility: string;
  createdAt: number;
  subscriberCount: number;
  subscribed: number;
};

function publicShare(row: ShareRow) {
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    owner: row.owner,
    visibility: JSON.parse(row.visibility) as "all" | string[],
    createdAt: row.createdAt,
    subscriberCount: Number(row.subscriberCount),
  };
}

function shareRows(db: Database, viewerId: string): ShareRow[] {
  return db.prepare(`
    SELECT s.id,s.type,s.label,s.owner_id,u.name AS owner,u.disabled AS owner_disabled,
      s.payload,s.visibility,s.created_at AS createdAt,
      (SELECT COUNT(*) FROM share_subscriptions ss WHERE ss.share_id=s.id) AS subscriberCount,
      EXISTS(SELECT 1 FROM share_subscriptions mine WHERE mine.share_id=s.id AND mine.user_id=?) AS subscribed
    FROM shares s JOIN users u ON u.id=s.owner_id ORDER BY s.created_at DESC
  `).all(viewerId) as ShareRow[];
}

function visibleTo(row: ShareRow, user: SessionUser): boolean {
  if (row.owner_disabled || row.owner_id === user.id) return false;
  const visibility = JSON.parse(row.visibility) as "all" | string[];
  return visibility === "all" || visibility.includes(user.name);
}

async function jsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await req.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseStoredShare(row: Pick<ShareRow, "id" | "type" | "payload">): ShareInjection {
  return { id: row.id, type: row.type, payload: JSON.parse(row.payload) as unknown };
}

function orchestrationError(cause: unknown): Response {
  if (cause instanceof OrchestrationError) return error(cause.status, cause.message);
  console.error("[trellis-gw] share orchestration failed", cause);
  return error(500, "tenant orchestration failed");
}

async function handleShares(req: Request, url: URL, user: SessionUser, db: Database): Promise<Response> {
  if (url.pathname === "/__gw/api/shares" && req.method === "GET") {
    const rows = shareRows(db, user.id);
    return Response.json({
      published: rows.filter((row) => row.owner_id === user.id).map(publicShare),
      available: rows.filter((row) => visibleTo(row, user)).map((row) => ({
        ...publicShare(row), subscribed: Boolean(row.subscribed),
      })),
    });
  }

  if (url.pathname === "/__gw/api/shares" && req.method === "POST") {
    const body = await jsonBody(req);
    if (!body) return error(400, "invalid JSON body");
    const type = body.type;
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if ((type !== "claude-token" && type !== "endpoint") || !label || label.length > 120) {
      return error(400, "invalid share metadata");
    }
    let visibility: "all" | string[];
    if (body.visibility === "all") visibility = "all";
    else if (Array.isArray(body.visibility) && body.visibility.every(
      (name) => typeof name === "string" && /^[a-z0-9-]{1,32}$/.test(name),
    )) visibility = [...new Set(body.visibility as string[])];
    else return error(400, "invalid visibility");

    let payload: unknown;
    try {
      if (type === "claude-token") {
        const token = (body.payload as { token?: unknown } | null)?.token;
        if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token)) {
          return error(400, "invalid claude-token payload");
        }
        payload = { token: token.trim() };
      } else {
        payload = validateEndpointPayload(body.payload);
      }
    } catch (cause) {
      return error(400, cause instanceof Error ? cause.message : "invalid endpoint payload");
    }
    const id = randomUUID();
    db.prepare(
      "INSERT INTO shares (id,type,label,owner_id,payload,visibility,created_at) VALUES (?,?,?,?,?,?,?)",
    ).run(id, type, label, user.id, JSON.stringify(payload), JSON.stringify(visibility), Date.now());
    return Response.json({ id }, { status: 201 });
  }

  const match = url.pathname.match(/^\/__gw\/api\/shares\/([^/]+)(\/subscribe)?$/);
  if (!match) return error(404, "not found");
  const id = decodeURIComponent(match[1]);
  const subscription = Boolean(match[2]);

  if (!subscription && req.method === "DELETE") {
    const row = shareRows(db, user.id).find((item) => item.id === id && item.owner_id === user.id);
    if (!row) return error(404, "share not found");
    const subscribers = db.prepare(`
      SELECT u.tenant FROM share_subscriptions ss JOIN users u ON u.id=ss.user_id
      WHERE ss.share_id=? ORDER BY ss.created_at
    `).all(id) as Array<{ tenant: string }>;
    try {
      for (const subscriber of subscribers) {
        await removeShareInjection(subscriber.tenant, parseStoredShare(row));
      }
    } catch (cause) {
      return orchestrationError(cause);
    }
    db.prepare("DELETE FROM shares WHERE id=?").run(id);
    return new Response(null, { status: 204 });
  }

  if (subscription && req.method === "POST") {
    const row = shareRows(db, user.id).find((item) => item.id === id);
    if (!row || !visibleTo(row, user)) return error(404, "share not available");
    let willRestart: boolean;
    try {
      willRestart = await applyShareInjection(user.tenant, parseStoredShare(row));
    } catch (cause) {
      return orchestrationError(cause);
    }
    db.transaction(() => {
      if (row.type === "claude-token") {
        db.prepare(`
          DELETE FROM share_subscriptions WHERE user_id=? AND share_id IN
            (SELECT id FROM shares WHERE type='claude-token')
        `).run(user.id);
      }
      db.prepare(
        "INSERT OR REPLACE INTO share_subscriptions (share_id,user_id,created_at) VALUES (?,?,?)",
      ).run(id, user.id, Date.now());
    })();
    return Response.json({ willRestart }, { status: 202 });
  }

  if (subscription && req.method === "DELETE") {
    const row = shareRows(db, user.id).find((item) => item.id === id && Boolean(item.subscribed));
    if (!row) return error(404, "subscription not found");
    let willRestart: boolean;
    try {
      willRestart = await removeShareInjection(user.tenant, parseStoredShare(row));
    } catch (cause) {
      return orchestrationError(cause);
    }
    db.prepare("DELETE FROM share_subscriptions WHERE share_id=? AND user_id=?").run(id, user.id);
    return Response.json({ willRestart }, { status: 202 });
  }

  return error(404, "not found");
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
  if (url.pathname === "/__gw/api/shares" || url.pathname.startsWith("/__gw/api/shares/")) {
    return handleShares(req, url, user, db);
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
