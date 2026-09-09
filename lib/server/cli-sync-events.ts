import "server-only";
import { refreshPendingSnapshot } from "./pending";

type CliSyncEvent = { type: "pending_changed" } | {
  type: "session_updated";
  sessionId: string;
};

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

export function subscribeCliSync(sub: Subscriber): () => void {
  subscribers.add(sub);
  return () => subscribers.delete(sub);
}
