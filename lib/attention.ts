import type { HerdrSessionStatus } from "./herdr-ui";
import type { PendingItem } from "./pending";

// 「等你处理」的唯一判定来源：侧栏行首状态槽、侧栏「等你处理」分组、标签页标题
// 前缀三处共用，保证三处数字 / 记号永远一致。
//
// 等你回答 = ① pending 快照里有这个会话的审批 / 提问（网页 / CLI 会话，store.pending，
// 已在提交中的不算 —— 与 usePendingActions 同口径）；② Herdr 窗格在线且处于
// waiting / blocked（原状态槽的判定）。

type HerdrLike = Pick<HerdrSessionStatus, "alive" | "status">;

export function isHerdrWaiting(h: HerdrLike | null | undefined): boolean {
  return !!h?.alive && (h.status === "waiting" || h.status === "blocked");
}

export function waitingSessionIds(
  pending: readonly Pick<PendingItem, "sessionId" | "nodeId">[],
  submitting: ReadonlySet<string>,
  herdr: ReadonlyMap<string, HerdrLike>,
): Set<string> {
  const ids = new Set<string>();
  for (const item of pending) {
    if (!submitting.has(item.nodeId)) ids.add(item.sessionId);
  }
  for (const [id, status] of herdr) {
    if (isHerdrWaiting(status)) ids.add(id);
  }
  return ids;
}

/**
 * 「等你处理」分组的成员与顺序：先等你回答，再完成·未读；组内保持传入顺序
 * （调用方传 updated_at DESC，即最近活跃在前）。按 id 去重。
 */
export function prioritySessions<T extends { id: string }>(
  candidates: readonly T[],
  waiting: ReadonlySet<string>,
  unread: ReadonlySet<string>,
): { session: T; reason: "waiting" | "unread" }[] {
  const seen = new Set<string>();
  const waitingRows: { session: T; reason: "waiting" }[] = [];
  const unreadRows: { session: T; reason: "unread" }[] = [];
  for (const s of candidates) {
    if (seen.has(s.id)) continue;
    if (waiting.has(s.id)) waitingRows.push({ session: s, reason: "waiting" });
    else if (unread.has(s.id)) unreadRows.push({ session: s, reason: "unread" });
    else continue;
    seen.add(s.id);
  }
  return [...waitingRows, ...unreadRows];
}

const PREFIX_RE = /^\(\d+\) /;

/** 去掉本模块加上的「(N) 」前缀，拿回原标题。 */
export function stripAttentionPrefix(title: string): string {
  return title.replace(PREFIX_RE, "");
}

/** 标签页标题：有 N 个会话等你回答时前缀「(N) 」，0 时恢复原标题。幂等。 */
export function attentionTitle(title: string, count: number): string {
  const base = stripAttentionPrefix(title);
  return count > 0 ? `(${Math.floor(count)}) ${base}` : base;
}
