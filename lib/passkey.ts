// Passkey（WebAuthn）登录的纯逻辑：RP 白名单解析、challenge 一次性存取、失败限速。
// 不碰 DB / 请求对象 / 时钟以外的副作用，单测见 lib/passkey.test.ts。
//
// 安全模型（详见 lib/server/passkeys.ts 顶部）：
// - origin 只取浏览器自己填的 `Origin` 请求头，必须命中白名单才发 challenge；
//   X-Forwarded-Host 可被客户端伪造（server.ts 只在缺省时补它），这里不信它。
// - 白名单之外的 origin 根本拿不到 challenge；拿到的 challenge 绑定发放时的 origin/rpId，
//   verify 时以绑定值为准，再由 WebAuthn 签名里的 clientDataJSON.origin / rpIdHash 兜底。

/** prod 公网域名。TRELLIS_PASSKEY_ORIGINS 未配置时的默认白名单 = 它 + 任意端口的 localhost。 */
export const DEFAULT_PASSKEY_ORIGINS = ["https://trellis.smokingmouse.cc"];

export type RpBinding = { origin: string; rpId: string };

export type OriginAllowlist = {
  /** 精确匹配的 origin（scheme://host[:port]，已规范化）。 */
  exact: Set<string>;
  /** 是否放行 http(s)://localhost:<任意端口>（本地测试）。 */
  anyLocalhost: boolean;
};

/** 把一个 origin 字符串规范成 URL.origin 形式；不是合法的 http(s) origin 返回 null。 */
export function normalizeOrigin(raw: string): string | null {
  const s = raw.trim();
  if (!s || s === "null") return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  // origin 不带 path/query/userinfo；带了说明不是 Origin 头的形态。
  if (u.username || u.password) return null;
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash) return null;
  return u.origin;
}

/**
 * 解析白名单配置。`TRELLIS_PASSKEY_ORIGINS` 逗号分隔；特殊项 `localhost` 表示放行
 * 任意端口的 http://localhost。未配置（undefined / 空串）时用默认：prod 域名 + localhost。
 * 非法项直接丢弃（不让一个手误把整张表变成放行全部）。
 */
export function parseAllowedOrigins(raw: string | undefined): OriginAllowlist {
  const items =
    raw && raw.trim()
      ? raw.split(",").map((s) => s.trim()).filter(Boolean)
      : [...DEFAULT_PASSKEY_ORIGINS, "localhost"];
  const exact = new Set<string>();
  let anyLocalhost = false;
  for (const item of items) {
    if (item === "localhost") {
      anyLocalhost = true;
      continue;
    }
    const o = normalizeOrigin(item);
    if (o) exact.add(o);
  }
  return { exact, anyLocalhost };
}

/**
 * 由请求的 Origin 头推出 RP 绑定。白名单外 / 非法 / 缺失 → null。
 *
 * rpId = origin 的 hostname（不做父域放宽：prod 只有一个域名，放宽到父域只会扩大
 * 可用 origin 面）。WebAuthn 不允许 IP 作 rpId，127.0.0.1 之类即便误配进白名单也拒。
 */
export function resolveRp(originHeader: string | null | undefined, allow: OriginAllowlist): RpBinding | null {
  if (!originHeader) return null;
  const origin = normalizeOrigin(originHeader);
  if (!origin) return null;
  const u = new URL(origin);
  const host = u.hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return null;
  const isLocalhost = host === "localhost";
  // 非 localhost 必须 https（WebAuthn 本身也只在安全上下文可用，这里提前挡住）。
  if (!isLocalhost && u.protocol !== "https:") return null;
  if (allow.exact.has(origin) || (isLocalhost && allow.anyLocalhost)) {
    return { origin, rpId: host };
  }
  return null;
}

// ── challenge 存取 ─────────────────────────────────────────────────────────

export type ChallengeKind = "register" | "login";

type ChallengeEntry = RpBinding & { kind: ChallengeKind; expiresAt: number };

/**
 * 服务端短期 challenge 存储：发放时登记，verify 时 consume（取出即删，一次性）。
 * - 过期（TTL）即失效；
 * - 容量封顶：login options 是公开接口，不封顶会被刷爆内存。满了先清过期，再挤掉最老的。
 * - consume 校验 kind：注册 challenge 不能拿去登录，反之亦然。
 */
export class ChallengeStore {
  private readonly map = new Map<string, ChallengeEntry>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  issue(challenge: string, kind: ChallengeKind, rp: RpBinding): void {
    const t = this.now();
    if (this.map.size >= this.maxEntries) this.sweep(t);
    while (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    this.map.set(challenge, { ...rp, kind, expiresAt: t + this.ttlMs });
  }

  /** 取出并删除。不存在 / 过期 / kind 不符 → null（无论哪种都已删掉，不可重试）。 */
  consume(challenge: string, kind: ChallengeKind): RpBinding | null {
    const e = this.map.get(challenge);
    if (!e) return null;
    this.map.delete(challenge);
    if (e.kind !== kind || e.expiresAt <= this.now()) return null;
    return { origin: e.origin, rpId: e.rpId };
  }

  get size(): number {
    return this.map.size;
  }

  private sweep(t: number): void {
    for (const [k, e] of this.map) if (e.expiresAt <= t) this.map.delete(k);
  }
}

/** 从 base64url 编码的 clientDataJSON 里取 challenge（verify 前定位 store 条目用）。 */
export function challengeFromClientData(clientDataJSONb64url: unknown): string | null {
  if (typeof clientDataJSONb64url !== "string" || !clientDataJSONb64url) return null;
  try {
    const json = Buffer.from(clientDataJSONb64url, "base64url").toString("utf8");
    const c = (JSON.parse(json) as { challenge?: unknown }).challenge;
    return typeof c === "string" && c ? c : null;
  } catch {
    return null;
  }
}

// ── 失败限速 ───────────────────────────────────────────────────────────────

/**
 * 固定窗口的失败计数限速：同一个 key 在窗口内失败 perKey 次即封到窗口结束；
 * 全体 key 合计失败 global 次同样全封（客户端 IP 头可以伪造，单靠 per-key 拦不住
 * 换 key 的爆破，global 是兜底）。成功只清自己 key 的计数，不清 global。
 */
export class FailureLimiter {
  private readonly keys = new Map<string, { count: number; windowStart: number }>();
  private global = { count: 0, windowStart: 0 };

  constructor(
    private readonly opts: { windowMs: number; perKey: number; global: number; maxKeys?: number },
    private readonly now: () => number = Date.now,
  ) {}

  /** 被封时返回还需等待的毫秒数，否则 0。 */
  blockedFor(key: string): number {
    const t = this.now();
    const g = this.live(this.global, t);
    if (g && g.count >= this.opts.global) return g.windowStart + this.opts.windowMs - t;
    const k = this.keys.get(key);
    const kl = k ? this.live(k, t) : null;
    if (kl && kl.count >= this.opts.perKey) return kl.windowStart + this.opts.windowMs - t;
    return 0;
  }

  recordFailure(key: string): void {
    const t = this.now();
    if (!this.live(this.global, t)) this.global = { count: 0, windowStart: t };
    this.global.count++;
    let k = this.keys.get(key);
    if (!k || !this.live(k, t)) {
      if (!k && this.keys.size >= (this.opts.maxKeys ?? 10_000)) this.prune(t);
      k = { count: 0, windowStart: t };
      this.keys.set(key, k);
    }
    k.count++;
  }

  recordSuccess(key: string): void {
    this.keys.delete(key);
  }

  private live<T extends { windowStart: number }>(w: T, t: number): T | null {
    return t - w.windowStart < this.opts.windowMs ? w : null;
  }

  private prune(t: number): void {
    for (const [k, w] of this.keys) if (!this.live(w, t)) this.keys.delete(k);
    // 还满（被刷了大量不同 key）：整表清掉，global 计数仍在兜底。
    if (this.keys.size >= (this.opts.maxKeys ?? 10_000)) this.keys.clear();
  }
}
