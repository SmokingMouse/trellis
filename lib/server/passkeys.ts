import "server-only";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { getDB } from "./sqlite";
import { dbWrite } from "./db-error";
import {
  ChallengeStore,
  challengeFromClientData,
  parseAllowedOrigins,
  resolveRp,
  type RpBinding,
} from "@/lib/passkey";

// Passkey（WebAuthn）登录：在口令之外**增加**一种签发同一个会话 cookie 的方式。
//
// 安全设计：
// - 注册只能在已登录状态下做（路由里 hasValidSession 二次确认，proxy.ts 闸在前）。
// - RP：origin 只认浏览器填的 `Origin` 头，必须命中 TRELLIS_PASSKEY_ORIGINS 白名单
//   （默认 https://trellis.smokingmouse.cc + 任意端口 localhost）；rpId = 该 origin 的
//   hostname。不看 X-Forwarded-Host —— server.ts 只在它缺省时才补，客户端可以自带。
// - challenge 服务端生成、绑定发放时的 origin/rpId/用途，5 分钟 TTL，verify 时先 consume
//   （一次性：无论成败都作废），再以绑定值作 expectedOrigin/expectedRPID 交给
//   simplewebauthn 校验签名（clientDataJSON.origin、rpIdHash 由认证器签名覆盖，伪造不了）。
// - userVerification = required：注册与登录都要求认证器做过 Face ID / 指纹 / PIN，
//   verify 时 requireUserVerification=true 再在服务端核 UV 位，不是「持有设备即可」。
// - 登录用 discoverable credential（residentKey required），不需要先输用户名，支持
//   conditional UI（密码框自动填充里直接选 passkey）。单用户部署，user.id 固定。
// - signCount 每次登录回写；simplewebauthn 对非零计数器做单调递增检查（回退 = 疑似克隆，拒）。

const RP_NAME = "Trellis";
const USER_NAME = "trellis";
// 单用户部署：所有 passkey 挂在同一个 user handle 下。固定值让同一认证器重复注册时
// 覆盖而不是堆积（再配合 excludeCredentials 直接提示「已注册」）。
const USER_ID = new TextEncoder().encode("trellis-owner");

const CHALLENGE_TTL_MS = 5 * 60_000;
const CHALLENGE_MAX = 500;
const CEREMONY_TIMEOUT_MS = 120_000;

const shared = globalThis as typeof globalThis & { __trellisPasskeyChallenges?: ChallengeStore };
function challenges(): ChallengeStore {
  shared.__trellisPasskeyChallenges ??= new ChallengeStore(CHALLENGE_TTL_MS, CHALLENGE_MAX);
  return shared.__trellisPasskeyChallenges;
}

/** 由请求的 Origin 头解析 RP；白名单外返回 null。 */
export function rpFromRequest(req: Request): RpBinding | null {
  return resolveRp(req.headers.get("origin"), parseAllowedOrigins(process.env.TRELLIS_PASSKEY_ORIGINS));
}

// ── 存储 ───────────────────────────────────────────────────────────────────

type Row = {
  id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string | null;
  name: string;
  rp_id: string;
  device_type: string | null;
  backed_up: number;
  created_at: number;
  last_used_at: number | null;
};

export type PasskeyListItem = {
  id: string;
  name: string;
  rpId: string;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: number;
  lastUsedAt: number | null;
};

const toItem = (r: Row): PasskeyListItem => ({
  id: r.id,
  name: r.name,
  rpId: r.rp_id,
  deviceType: r.device_type,
  backedUp: r.backed_up === 1,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

export function listPasskeys(): PasskeyListItem[] {
  const rows = getDB()
    .prepare("SELECT * FROM webauthn_credentials ORDER BY COALESCE(last_used_at, created_at) DESC")
    .all() as Row[];
  return rows.map(toItem);
}

function getRow(id: string): Row | null {
  return (getDB().prepare("SELECT * FROM webauthn_credentials WHERE id = ?").get(id) as Row | null) ?? null;
}

function parseTransports(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : undefined;
  } catch {
    return undefined;
  }
}

export function deletePasskey(id: string): boolean {
  const res = dbWrite("deletePasskey", () =>
    getDB().prepare("DELETE FROM webauthn_credentials WHERE id = ?").run(id),
  );
  return res.changes > 0;
}

/** 名称：去首尾空白、压掉控制字符、截 64 字；空 → 按时间给个默认名。 */
export function sanitizePasskeyName(raw: unknown, now = Date.now()): string {
  const s = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64) : "";
  if (s) return s;
  const d = new Date(now);
  return `Passkey ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── 注册 ───────────────────────────────────────────────────────────────────

export async function beginRegistration(rp: RpBinding): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existing = getDB()
    .prepare("SELECT id, transports FROM webauthn_credentials WHERE rp_id = ?")
    .all(rp.rpId) as Pick<Row, "id" | "transports">[];
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpId,
    userName: USER_NAME,
    userDisplayName: RP_NAME,
    userID: USER_ID,
    timeout: CEREMONY_TIMEOUT_MS,
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: parseTransports(c.transports) })),
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    },
  });
  challenges().issue(options.challenge, "register", rp);
  return options;
}

export type CeremonyResult<T> = { ok: true; value: T } | { ok: false; error: string };

export async function finishRegistration(
  rp: RpBinding,
  response: RegistrationResponseJSON,
  name: string,
): Promise<CeremonyResult<PasskeyListItem>> {
  const bound = consumeFor(response?.response?.clientDataJSON, "register", rp);
  if (!bound.ok) return bound;
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: bound.value.challenge,
      expectedOrigin: bound.value.rp.origin,
      expectedRPID: bound.value.rp.rpId,
      requireUserVerification: true,
    });
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "注册校验失败" };
  }
  if (!verification.verified) return { ok: false, error: "注册校验失败" };
  const info = verification.registrationInfo;
  const now = Date.now();
  const row: Row = {
    id: info.credential.id,
    public_key: info.credential.publicKey,
    counter: info.credential.counter,
    transports: info.credential.transports ? JSON.stringify(info.credential.transports) : null,
    name,
    rp_id: bound.value.rp.rpId,
    device_type: info.credentialDeviceType,
    backed_up: info.credentialBackedUp ? 1 : 0,
    created_at: now,
    last_used_at: null,
  };
  try {
    dbWrite("insertPasskey", () =>
      getDB()
        .prepare(
          `INSERT INTO webauthn_credentials
             (id, public_key, counter, transports, name, rp_id, device_type, backed_up, created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(row.id, row.public_key, row.counter, row.transports, row.name, row.rp_id, row.device_type, row.backed_up, row.created_at),
    );
  } catch (cause) {
    if (String(cause).includes("UNIQUE")) return { ok: false, error: "这把 passkey 已经注册过了" };
    throw cause;
  }
  return { ok: true, value: toItem(row) };
}

// ── 登录 ───────────────────────────────────────────────────────────────────

export async function beginLogin(rp: RpBinding): Promise<PublicKeyCredentialRequestOptionsJSON> {
  // 不给 allowCredentials：discoverable credential 由认证器自己列出可选的 passkey，
  // 也不把「这台服务注册了哪些 credential id」泄露给未登录的访客。
  const options = await generateAuthenticationOptions({
    rpID: rp.rpId,
    timeout: CEREMONY_TIMEOUT_MS,
    userVerification: "required",
  });
  challenges().issue(options.challenge, "login", rp);
  return options;
}

export async function finishLogin(
  rp: RpBinding,
  response: AuthenticationResponseJSON,
): Promise<CeremonyResult<{ id: string }>> {
  const bound = consumeFor(response?.response?.clientDataJSON, "login", rp);
  if (!bound.ok) return bound;
  const id = typeof response?.id === "string" ? response.id : "";
  const row = id ? getRow(id) : null;
  // 未知 credential（已删除 / 从没注册）与 RP 不符同样处理：一律「passkey 无效」。
  if (!row || row.rp_id !== bound.value.rp.rpId) return { ok: false, error: "这把 passkey 未注册或已被删除" };
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: bound.value.challenge,
      expectedOrigin: bound.value.rp.origin,
      expectedRPID: bound.value.rp.rpId,
      requireUserVerification: true,
      credential: {
        id: row.id,
        publicKey: new Uint8Array(row.public_key),
        counter: row.counter,
        transports: parseTransports(row.transports),
      },
    });
  } catch (cause) {
    // 细节只进服务端日志：这是未登录可达的接口，不把校验器的内部原因回给访客。
    console.warn(`[passkey] login verify failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    return { ok: false, error: "登录校验失败" };
  }
  if (!verification.verified || !verification.authenticationInfo.userVerified) {
    return { ok: false, error: "登录校验失败" };
  }
  const info = verification.authenticationInfo;
  dbWrite("touchPasskey", () =>
    getDB()
      .prepare("UPDATE webauthn_credentials SET counter = ?, backed_up = ?, last_used_at = ? WHERE id = ?")
      .run(info.newCounter, info.credentialBackedUp ? 1 : 0, Date.now(), row.id),
  );
  return { ok: true, value: { id: row.id } };
}

/**
 * 从 clientDataJSON 里拿 challenge 并 consume。除了 store 里绑定的 origin，还要求本次
 * 请求的 Origin 与之相同（换个白名单内的 origin 来交 verify 也不行）。
 */
function consumeFor(
  clientDataJSON: unknown,
  kind: "register" | "login",
  rp: RpBinding,
): CeremonyResult<{ challenge: string; rp: RpBinding }> {
  const challenge = challengeFromClientData(clientDataJSON);
  if (!challenge) return { ok: false, error: "请求格式不对" };
  const bound = challenges().consume(challenge, kind);
  if (!bound) return { ok: false, error: "challenge 无效或已过期，请重试" };
  if (bound.origin !== rp.origin || bound.rpId !== rp.rpId) return { ok: false, error: "来源不一致" };
  return { ok: true, value: { challenge, rp: bound } };
}
