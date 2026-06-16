import "server-only";

type CliSyncEvent = {
  type: "session_updated";
  sessionId: string;
};

type Subscriber = {
  onEvent: (event: CliSyncEvent) => void;
  onClose: () => void;
};

const subscribers = new Set<Subscriber>();

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
