// 发送 Outbox：离线 / 请求失败的消息先存进 localStorage，刷新页面不丢，网络回来后按顺序自动重发。
// 每条带 client_msg_id（= OutboxItem.id），重发沿用同一个，服务端按 TTL 去重 —— 上一次其实已经送到、
// 只是响应丢了，也不会重复打字 / 重复起一轮。
//
// 只收「消息」：herdr 窗格输入、自起会话的 chat 提问。审批、按键这类一次性操作不进 Outbox ——
// 过了几分钟再按下去，屏幕早就不是当时那张卡了。
//
// 这里是纯函数（状态变换 + 序列化 + 退避 + 失败分类），浏览器侧的调度见 lib/outbox-client.ts，
// 单测见 outbox.test.ts。

export type OutboxKind = "herdr" | "chat";

export type OutboxItem = {
  /** client_msg_id */
  id: string;
  kind: OutboxKind;
  /** 同一 target 内严格按入队顺序发：herdr = paneId，chat = 会话 id（新会话为 "new"） */
  target: string;
  /** 给人看的原文（排队列表 / 放回输入框） */
  text: string;
  /** 重发用的请求体 */
  payload: Record<string, unknown>;
  createdAt: number;
  /** 已经失败过几次（可重试的失败） */
  attempts: number;
  /** 下次最早什么时候重发（退避） */
  nextAt: number;
  lastError?: string;
  /**
   * 不可重试的失败（读屏拒发、4xx）：不再自动发，等宿主（输入框）把它取走、放回输入框并提示。
   * code 是服务端给的原因码（dialog_open / input_draft …），没有时为 undefined。
   */
  failed?: { message: string; code?: string; clearable?: string };
};

export const OUTBOX_STORAGE_KEY = "trellis:outbox:v1";
/** 超过这么久还没发出去的，不再自动发（标记失败，交还给用户决定）。 */
export const OUTBOX_MAX_AGE_MS = 24 * 60 * 60_000;
const OUTBOX_MAX_ITEMS = 200;

export function backoffMs(attempts: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempts - 1));
}

/**
 * 失败能不能重发：网络层失败（status 0）、超时、限流、网关 / 服务不可用 → 重发；
 * 其余 4xx / 5xx 是服务端明确拒了或处理出错，重发也一样，交还给用户。
 */
export function isRetriableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 425 || status === 429 || status === 502 || status === 503 || status === 504;
}

function isItem(value: unknown): value is OutboxItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<OutboxItem>;
  return (
    typeof item.id === "string" &&
    (item.kind === "herdr" || item.kind === "chat") &&
    typeof item.target === "string" &&
    typeof item.text === "string" &&
    !!item.payload &&
    typeof item.payload === "object" &&
    typeof item.createdAt === "number" &&
    typeof item.attempts === "number" &&
    typeof item.nextAt === "number"
  );
}

/** localStorage 里读出来的串 → 条目；坏数据整条丢弃，过期的标成失败。 */
export function parseOutbox(raw: string | null, now = Date.now()): OutboxItem[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isItem).map((item) =>
    !item.failed && now - item.createdAt > OUTBOX_MAX_AGE_MS
      ? { ...item, failed: { message: "这条消息很久没发出去，已停止自动重发" } }
      : item,
  );
}

export function serializeOutbox(items: OutboxItem[]): string {
  return JSON.stringify(items);
}

export function newOutboxItem(
  fields: Pick<OutboxItem, "id" | "kind" | "target" | "text" | "payload">,
  now = Date.now(),
): OutboxItem {
  return { ...fields, createdAt: now, attempts: 0, nextAt: now };
}

/** 入队（同 id 已在就不重复加）；超上限时丢最早的已失败条目，再不够丢最早的。 */
export function enqueueOutbox(items: OutboxItem[], item: OutboxItem): OutboxItem[] {
  if (items.some((existing) => existing.id === item.id)) return items;
  let next = [...items, item];
  while (next.length > OUTBOX_MAX_ITEMS) {
    const failedAt = next.findIndex((entry) => entry.failed);
    next = next.filter((_, i) => i !== (failedAt >= 0 ? failedAt : 0));
  }
  return next;
}

export function removeOutbox(items: OutboxItem[], id: string): OutboxItem[] {
  return items.some((item) => item.id === id) ? items.filter((item) => item.id !== id) : items;
}

/** 可重试的失败：次数 +1，按退避推后下次重发时间。 */
export function markOutboxRetry(items: OutboxItem[], id: string, error: string, now = Date.now()): OutboxItem[] {
  return items.map((item) => {
    if (item.id !== id) return item;
    const attempts = item.attempts + 1;
    return { ...item, attempts, nextAt: now + backoffMs(attempts), lastError: error };
  });
}

/** 不可重试的失败：停止自动发，等宿主取走。 */
export function markOutboxFailed(items: OutboxItem[], id: string, failed: NonNullable<OutboxItem["failed"]>): OutboxItem[] {
  return items.map((item) => (item.id === id ? { ...item, failed } : item));
}

/** 网络恢复：所有在等退避的条目立即可发（不清零次数）。 */
export function wakeOutbox(items: OutboxItem[], now = Date.now()): OutboxItem[] {
  return items.some((item) => !item.failed && item.nextAt > now)
    ? items.map((item) => (!item.failed && item.nextAt > now ? { ...item, nextAt: now } : item))
    : items;
}

/**
 * 现在该发哪些：每个 target 只看它最早一条没失败的（前一条没发出去，后面的都得等，保证顺序），
 * 且到了重发时间、不在 skip（正在发 / 本页正自己发着）里。按入队顺序返回。
 */
export function dueOutbox(items: OutboxItem[], now = Date.now(), skip: ReadonlySet<string> = new Set()): OutboxItem[] {
  const seen = new Set<string>();
  const due: OutboxItem[] = [];
  const ordered = [...items].sort((a, b) => a.createdAt - b.createdAt);
  for (const item of ordered) {
    if (item.failed) continue;
    const lane = `${item.kind}:${item.target}`;
    if (seen.has(lane)) continue;
    seen.add(lane);
    if (item.nextAt <= now && !skip.has(item.id)) due.push(item);
  }
  return due;
}

/** 还在等着发的条数（不含已失败待取走的）。 */
export function pendingOutboxCount(items: OutboxItem[]): number {
  return items.reduce((n, item) => (item.failed ? n : n + 1), 0);
}

/** 某个输入框（kind + target）名下的条目，按入队顺序。 */
export function outboxFor(items: OutboxItem[], kind: OutboxKind, target: string): OutboxItem[] {
  return items.filter((item) => item.kind === kind && item.target === target).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * 标题位的网络状态：离线 →「等待网络」；在线但推送流断了（曾经连上过）或还有消息在等重发 →「连接中…」；
 * 都好返回 null（显示原标题）。
 */
export function networkTitle(state: {
  online: boolean;
  streamConnected: boolean;
  streamEverConnected: boolean;
  pending: number;
}): "等待网络" | "连接中…" | null {
  if (!state.online) return "等待网络";
  if ((!state.streamConnected && state.streamEverConnected) || state.pending > 0) return "连接中…";
  return null;
}
