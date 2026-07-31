import "server-only";

// S88: 任务执行的站内广播。结构照抄 cli-sync-events.ts —— 同一个模式，
// 别为了「更通用」造一个共享抽象，两个 30 行的文件比一个带泛型的好读。

export type TaskEvent =
  | { type: "run_started"; taskId: string; runId: string }
  | { type: "run_updated"; taskId: string; runId: string }
  | { type: "run_finished"; taskId: string; runId: string; status: string };

type Subscriber = {
  onEvent: (event: TaskEvent) => void;
  onClose: () => void;
};

const subscribers = new Set<Subscriber>();

export function publishTaskEvent(event: TaskEvent): void {
  for (const sub of [...subscribers]) {
    try {
      sub.onEvent(event);
    } catch {
      sub.onClose();
      subscribers.delete(sub);
    }
  }
}

export function subscribeTaskEvents(sub: Subscriber): () => void {
  subscribers.add(sub);
  return () => subscribers.delete(sub);
}
