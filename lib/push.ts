// Web Push 的纯逻辑：设置解析、payload 构造、去重、前台判定、新增待处理项判定。
// 不碰 DB / 网络 / 浏览器 API —— 服务端（lib/server/push.ts）与 bun test 共用。

import { pendingKey, type PendingItem } from "./pending";

export type PushKind = "done" | "waiting";

// ── 设置（app_settings 表，经 /api/settings 读写）──────────────────────────
//
// 三个键都是「缺省 = 开」：没订阅时本来就什么都不发，默认开省得用户订阅完还要再
// 去找第二个开关。只有字面量 "0" 视为关（与 lib/prefs 的布尔存储同一写法）。
export const PUSH_SETTING_KEYS = {
  enabled: "push_enabled",
  done: "push_done",
  waiting: "push_waiting",
} as const;

export type PushSettings = { enabled: boolean; done: boolean; waiting: boolean };

export function parsePushSettings(get: (key: string) => string | null | undefined): PushSettings {
  const on = (key: string) => get(key)?.trim() !== "0";
  return {
    enabled: on(PUSH_SETTING_KEYS.enabled),
    done: on(PUSH_SETTING_KEYS.done),
    waiting: on(PUSH_SETTING_KEYS.waiting),
  };
}

export function pushKindAllowed(settings: PushSettings, kind: PushKind): boolean {
  return settings.enabled && settings[kind];
}

// ── payload ────────────────────────────────────────────────────────────────

export type PushPayload = {
  kind: PushKind | "test";
  title: string;
  body: string;
  /** 通知 tag：同一会话后来的一条原地替换前一条，不在通知中心叠一串。 */
  tag: string;
  /** 点开去哪（站内相对路径）。 */
  url: string;
  sessionId: string | null;
  nodeId: string | null;
  /** 发送时「等你回答」的会话总数（主屏图标角标，public/sw.js 用 Badging API 设）。
   *  缺省 = 不动角标（例如测试推送）。 */
  badge?: number;
};

/** 角标数：待处理快照里涉及的会话数（同一会话多项只算一个，与页面 lib/attention 同口径）。
 *  服务端看不到 Herdr 窗格状态与页面里「提交中」的项，那两处由页面打开时校正。 */
export function waitingBadgeCount(items: readonly Pick<PendingItem, "sessionId">[]): number {
  return new Set(items.map((i) => i.sessionId)).size;
}

const BODY_MAX = 140;
const TITLE_MAX = 60;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 回答正文 → 通知里能看的一句：去掉代码块与常见 markdown 记号，取开头。 */
export function plainSnippet(markdown: string, max = BODY_MAX): string {
  const text = markdown
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~]{1,3}/g, "");
  return clip(text, max);
}

export function sessionUrl(sessionId: string, nodeId?: string | null): string {
  const q = new URLSearchParams({ session: sessionId });
  if (nodeId) q.set("node", nodeId);
  return `/?${q.toString()}`;
}

export function buildPushPayload(e: {
  kind: PushKind;
  sessionId: string;
  sessionTitle?: string | null;
  nodeId?: string | null;
  /** done：回答正文（markdown）；waiting：待处理摘要。 */
  text?: string | null;
  /** waiting：这个会话里同时在等的项数。 */
  count?: number;
}): PushPayload {
  const name = clip(e.sessionTitle?.trim() || "未命名会话", TITLE_MAX);
  const title = e.kind === "done" ? `已完成 · ${name}` : `等你回答 · ${name}`;
  let body: string;
  if (e.kind === "done") {
    body = (e.text && plainSnippet(e.text)) || "这一轮跑完了";
  } else {
    const summary = e.text ? clip(e.text, BODY_MAX) : "";
    const more = e.count && e.count > 1 ? `（共 ${e.count} 项）` : "";
    body = `${summary || "有一项需要你处理"}${more}`;
  }
  return {
    kind: e.kind,
    title,
    body,
    tag: `trellis:${e.sessionId}`,
    url: sessionUrl(e.sessionId, e.nodeId),
    sessionId: e.sessionId,
    nodeId: e.nodeId ?? null,
  };
}

// ── 去重 ───────────────────────────────────────────────────────────────────
//
// 同一会话、同一类，窗口内只发第一条。通知 tag 已经会原地替换，这里防的是「短时间
// 连响好几下」（重试 / 一轮里连着弹几个审批）。

export const PUSH_DEDUPE_MS = 30_000;

export function dedupeKey(kind: PushKind, sessionId: string): string {
  return `${kind}:${sessionId}`;
}

/** 允许发 → 记下时间并返回 true；窗口内重复 → false。顺手清掉过期项防止 Map 无限长。 */
export function takeDedupeSlot(
  sent: Map<string, number>,
  key: string,
  now: number,
  windowMs = PUSH_DEDUPE_MS,
): boolean {
  for (const [k, at] of sent) if (now - at >= windowMs) sent.delete(k);
  const last = sent.get(key);
  if (last !== undefined && now - last < windowMs) return false;
  sent.set(key, now);
  return true;
}

// ── 前台判定（客户端心跳）───────────────────────────────────────────────────
//
// 每个打开的页面（clientId 是页面自己生成的随机串）在可见时每 PRESENCE_BEAT_MS
// 报一次「我在看 sessionId」，隐藏时立刻报一次「不看了」。服务端只在内存里留
// clientId → { sessionId, expiresAt }，过期即视为不在看（页面被系统杀掉、断网
// 都发不出「不看了」，靠 TTL 兜住）。

export const PRESENCE_BEAT_MS = 20_000;
export const PRESENCE_TTL_MS = 45_000;

export type PresenceEntry = { sessionId: string; expiresAt: number };

export function recordPresence(
  map: Map<string, PresenceEntry>,
  clientId: string,
  sessionId: string | null,
  visible: boolean,
  now: number,
): void {
  for (const [k, v] of map) if (v.expiresAt <= now) map.delete(k);
  if (!visible || !sessionId) {
    // 切会话时「旧会话不看了」（beacon）与「新会话在看」（fetch）可能乱序到达：
    // 只撤销同一会话的记录，晚到的旧「不看了」不能把新会话的前台状态抹掉。
    const cur = map.get(clientId);
    if (cur && (!sessionId || cur.sessionId === sessionId)) map.delete(clientId);
    return;
  }
  map.set(clientId, { sessionId, expiresAt: now + PRESENCE_TTL_MS });
}

export function isSessionForeground(
  map: Map<string, PresenceEntry>,
  sessionId: string,
  now: number,
): boolean {
  for (const v of map.values()) {
    if (v.sessionId === sessionId && v.expiresAt > now) return true;
  }
  return false;
}

// ── 新出现的待处理项 ─────────────────────────────────────────────────────────
//
// 待处理快照（lib/server/pending.ts）每次重算都会经过这里：与上一版比出「新冒出来
// 的」项，按会话聚合成一条推送。
//
// prevKeys = null 表示进程里第一次算快照 —— 这时库里已有的待处理项大多是重启前就
// 挂着的，重启一次全推一遍就是骚扰，所以只推 FRESH_MS 内刚创建的。之后的增量里，
// 创建时间早于 STALE_MS 的也不推（投影重建等把老项「重新发现」的情况）。

export const PENDING_FRESH_MS = 60_000;
export const PENDING_STALE_MS = 10 * 60_000;

export type WaitingGroup = {
  sessionId: string;
  sessionTitle: string;
  nodeId: string;
  summary: string;
  count: number;
};

export function newWaitingGroups(
  prevKeys: ReadonlySet<string> | null,
  items: readonly PendingItem[],
  now: number,
): WaitingGroup[] {
  const groups = new Map<string, WaitingGroup>();
  const cutoff = now - (prevKeys ? PENDING_STALE_MS : PENDING_FRESH_MS);
  for (const item of items) {
    if (prevKeys?.has(pendingKey(item))) continue;
    if (item.createdAt < cutoff) continue;
    const g = groups.get(item.sessionId);
    if (g) g.count++;
    else
      groups.set(item.sessionId, {
        sessionId: item.sessionId,
        sessionTitle: item.sessionTitle,
        nodeId: item.nodeId,
        summary: item.summary,
        count: 1,
      });
  }
  return [...groups.values()];
}

// ── 订阅入参校验 ─────────────────────────────────────────────────────────────

export type PushSubscriptionInput = { endpoint: string; p256dh: string; auth: string };

const B64URL = /^[A-Za-z0-9_-]+=*$/;

/** 浏览器 PushSubscription.toJSON() 的形状 → 校验后的扁平结构；不合法返回 null。 */
export function parseSubscription(raw: unknown): PushSubscriptionInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof r.endpoint === "string" ? r.endpoint : "";
  const p256dh = typeof r.keys?.p256dh === "string" ? r.keys.p256dh : "";
  const auth = typeof r.keys?.auth === "string" ? r.keys.auth : "";
  if (!endpoint || endpoint.length > 2048) return null;
  try {
    if (new URL(endpoint).protocol !== "https:") return null;
  } catch {
    return null;
  }
  if (!B64URL.test(p256dh) || p256dh.length > 200) return null;
  if (!B64URL.test(auth) || auth.length > 100) return null;
  return { endpoint, p256dh, auth };
}

/** 推送服务回这两个码 = 订阅已经不存在（用户撤了权限 / 卸了 PWA），删行。 */
export function isGoneStatus(status: number | undefined): boolean {
  return status === 404 || status === 410;
}
