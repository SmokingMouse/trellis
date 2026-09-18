import "server-only";
import { refreshPendingSnapshot } from "./pending";
import type { SqliteFailureKind } from "./db-error";

/** 一次 reimport 失败的对外形状。`kind` 是 SQLite 失败类别，非 DB 异常为 "other"。 */
export type CliSyncFailure = {
  /** 出问题的源 jsonl 绝对路径。 */
  path: string;
  /** 受影响的镜像会话（还没匹配到 attached 会话时为 null）。 */
  sessionId: string | null;
  kind: SqliteFailureKind | "other";
  /** 给人看的一句，不含 stack。 */
  message: string;
};

type CliSyncEvent =
  | { type: "pending_changed" }
  | {
      type: "session_updated";
      sessionId: string;
    }
  | ({ type: "sync_failed" } & CliSyncFailure);

type Subscriber = {
  onEvent: (event: CliSyncEvent) => void;
  onClose: () => void;
};

const shared = globalThis as typeof globalThis & { trellisCliSubscribers?: Set<Subscriber> };
const subscribers = shared.trellisCliSubscribers ??= new Set<Subscriber>();

export function publishPendingChanged(): void {
  refreshPendingSnapshot();
  for (const sub of [...subscribers]) {
    try { sub.onEvent({ type: "pending_changed" }); } catch { sub.onClose(); subscribers.delete(sub); }
  }
}

export function publishCliSessionUpdated(sessionId: string): void {
  const event: CliSyncEvent = { type: "session_updated", sessionId };
  for (const sub of [...subscribers]) {
    try {
      sub.onEvent(event);
    } catch {
      sub.onClose();
      subscribers.delete(sub);
    }
  }
}

/** 同步失败。镜像会话的界面本来只会停在旧快照上，这条事件是它唯一的出口。 */
export function publishCliSyncFailed(failure: CliSyncFailure): void {
  const event: CliSyncEvent = { type: "sync_failed", ...failure };
  for (const sub of [...subscribers]) {
    try {
      sub.onEvent(event);
    } catch {
      sub.onClose();
      subscribers.delete(sub);
    }
  }
}

export function subscribeCliSync(sub: Subscriber): () => void {
  subscribers.add(sub);
  return () => subscribers.delete(sub);
}
