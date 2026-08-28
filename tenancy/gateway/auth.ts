import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export const SESSION_COOKIE = "trellis_gw_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const attempts = new Map<string, number[]>();

type UserRow = {
  id: string;
  name: string;
  pass_hash: string | null;
  invite_code: string | null;
  tenant: string;
  disabled: number;
  role: UserRole;
};

export type UserRole = "admin" | "user";
export type SessionUser = Pick<UserRow, "id" | "name" | "tenant" | "role">;

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function inviteCode(): string {
  return randomBytes(24).toString("base64url");
}

export function addUser(
  db: Database,
  name: string,
  tenant: string,
  role: UserRole = "user",
): string {
  const code = inviteCode();
  db.prepare(
    "INSERT INTO users (id,name,pass_hash,invite_code,tenant,role,created_at) VALUES (?,?,?,?,?,?,?)",
  ).run(randomUUID(), name, null, code, tenant, role, Date.now());
  return code;
}

export function renewInvite(db: Database, name: string): string | null {
  const code = inviteCode();
  const result = db
    .prepare("UPDATE users SET pass_hash=NULL, invite_code=?, disabled=0 WHERE name=?")
    .run(code, name);
  if (!result.changes) return null;
  db.prepare("DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE name=?)").run(name);
  return code;
}

export function disableUser(db: Database, name: string): boolean {
  return db.prepare("UPDATE users SET disabled=1 WHERE name=?").run(name).changes > 0;
}

export function enableUser(db: Database, name: string): boolean {
  return db.prepare("UPDATE users SET disabled=0 WHERE name=?").run(name).changes > 0;
}

function issueSession(db: Database, userId: string): string {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions (token_hash,user_id,created_at,expires_at,last_seen_at) VALUES (?,?,?,?,?)",
  ).run(sha256(token), userId, now, now + SESSION_MS, now);
  return token;
}

function failureKey(scope: string, ip: string, name: string): string {
  return `${scope}\0${ip}\0${name.trim().toLocaleLowerCase("en-US")}`;
}

function isLimited(key: string): boolean {
  const cutoff = Date.now() - 60_000;
  const recent = (attempts.get(key) || []).filter((time) => time > cutoff);
  if (recent.length) attempts.set(key, recent);
  else attempts.delete(key);
  return recent.length >= 5;
}

function recordFailure(key: string): void {
  attempts.set(key, [...(attempts.get(key) || []), Date.now()]);
}

export function rateLimited(scope: "login" | "register", ip: string, name: string): boolean {
  return isLimited(failureKey(scope, ip, name));
}

export function recordRateFailure(scope: "login" | "register", ip: string, name: string): void {
  recordFailure(failureKey(scope, ip, name));
}

export function clearRateFailures(scope: "login" | "register", ip: string, name: string): void {
  attempts.delete(failureKey(scope, ip, name));
}

export async function login(
  db: Database,
  name: string,
  password: string,
  ip: string,
): Promise<{ status: 200; token: string } | { status: 401 | 429 }> {
  const key = failureKey("login", ip, name);
  if (isLimited(key)) return { status: 429 };
  const user = db.prepare("SELECT * FROM users WHERE name=?").get(name) as UserRow | null;
  const valid = Boolean(
    user?.pass_hash && !user.disabled && (await Bun.password.verify(password, user.pass_hash)),
  );
  if (!valid || !user) {
    recordFailure(key);
    return { status: 401 };
  }
  attempts.delete(key);
  return { status: 200, token: issueSession(db, user.id) };
}

export type RegisterResult =
  | { status: "ok"; token: string }
  | { status: "invalid_invite" | "username_taken" };

export async function registerUser(
  db: Database,
  code: string,
  name: string,
  password: string,
): Promise<RegisterResult> {
  const invite = db.prepare("SELECT 1 FROM invites WHERE code=? AND used_at IS NULL").get(code);
  if (!invite) return { status: "invalid_invite" };
  if (db.prepare("SELECT 1 FROM users WHERE name=?").get(name)) {
    return { status: "username_taken" };
  }

  const id = randomUUID();
  const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
  try {
    return db.transaction(() => {
      db.prepare(
        "INSERT INTO users (id,name,pass_hash,invite_code,tenant,role,created_at) VALUES (?,?,?,?,?,?,?)",
      ).run(id, name, hash, null, name, "user", Date.now());
      const consumed = db.prepare(
        "UPDATE invites SET used_by=?,used_at=? WHERE code=? AND used_at IS NULL",
      ).run(name, Date.now(), code);
      if (!consumed.changes) throw new Error("invite already used");
      return { status: "ok", token: issueSession(db, id) } as const;
    })();
  } catch (error) {
    if (db.prepare("SELECT 1 FROM users WHERE name=?").get(name)) {
      return { status: "username_taken" };
    }
    if (!db.prepare("SELECT 1 FROM invites WHERE code=? AND used_at IS NULL").get(code)) {
      return { status: "invalid_invite" };
    }
    throw error;
  }
}

export async function claimInvite(
  db: Database,
  code: string,
  password: string,
): Promise<string | null> {
  const user = db
    .prepare("SELECT * FROM users WHERE invite_code=? AND disabled=0")
    .get(code) as UserRow | null;
  if (!user || password.length < 8) return null;
  const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
  const changed = db
    .prepare("UPDATE users SET pass_hash=?, invite_code=NULL WHERE id=? AND invite_code=?")
    .run(hash, user.id, code).changes;
  return changed ? issueSession(db, user.id) : null;
}

export function cookieValue(req: Request, name = SESSION_COOKIE): string | null {
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

export function authenticate(db: Database, req: Request): SessionUser | null {
  const token = cookieValue(req);
  if (!token) return null;
  const now = Date.now();
  const user = db.prepare(`
    SELECT u.id,u.name,u.tenant,u.role FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0
  `).get(sha256(token), now) as SessionUser | null;
  if (user) {
    db.prepare("UPDATE sessions SET last_seen_at=? WHERE token_hash=?").run(now, sha256(token));
  }
  return user;
}

export function logout(db: Database, req: Request): void {
  const token = cookieValue(req);
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(sha256(token));
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`;
}
