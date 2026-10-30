// 浏览器侧的 Outbox 调度（状态变换见 lib/outbox.ts）：
//   - 条目存 localStorage（OUTBOX_STORAGE_KEY），跨标签页经 storage 事件同步，刷新页面不丢；
//   - 网络恢复（online）、推送流重连、回到前台、以及每 3 秒，把到点的条目按 target 顺序交给对应 sender 重发；
//   - 本页正自己发着的条目先 claim（如 chat 的流式请求、输入框的首发），调度器跳过它们，免得同一条并发两次；
//     页面刷新后 claim 自然清空，留在盘上的条目由调度器接手。
// 重发沿用条目 id 作为 client_msg_id，服务端去重，响应丢了重发也不会重复。
import {
  OUTBOX_STORAGE_KEY,
  dueOutbox,
  enqueueOutbox,
  isRetriableStatus,
  markOutboxFailed,
  markOutboxRetry,
  parseOutbox,
  removeOutbox,
  serializeOutbox,
  wakeOutbox,
  type OutboxItem,
  type OutboxKind,
} from "./outbox";
import { HerdrActionError, sendHerdrInput } from "./herdr-actions";
import { pageEvents } from "./page-events";

export type OutboxSendResult =
  | { ok: true }
  | { ok: false; retry: boolean; message: string; code?: string; clearable?: string };

export type OutboxSender = (item: OutboxItem) => Promise<OutboxSendResult>;

const KICK_INTERVAL_MS = 3_000;

/** 真浏览器才挂事件 / 定时器（单测里的 window 桩只有 localStorage）。 */
function hasDom(): boolean {
  return typeof window !== "undefined" && typeof window.addEventListener === "function" && typeof document !== "undefined";
}

/** 把 fetch / 动作抛出的错误归成「能不能重发」。 */
export function outboxFailure(error: unknown): Extract<OutboxSendResult, { ok: false }> {
  if (error instanceof HerdrActionError) {
    if (error.refusal) {
      return { ok: false, retry: false, message: error.message, code: error.refusal.code, clearable: error.refusal.clearable };
    }
    return { ok: false, retry: isRetriableStatus(error.status), message: error.message };
  }
  // fetch 本身抛错（TypeError: Failed to fetch / Load failed）= 网络层失败
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, retry: true, message };
}

class OutboxClient {
  private items: OutboxItem[] = [];
  private loaded = false;
  private started = false;
  private readonly listeners = new Set<() => void>();
  private readonly inflight = new Set<string>();
  private readonly claimed = new Set<string>();
  private readonly senders = new Map<OutboxKind, OutboxSender>();
  private readonly wakers = new Set<() => void>();

  private storage(): Storage | null {
    try {
      return typeof window !== "undefined" ? window.localStorage : null;
    } catch {
      return null;
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.items = parseOutbox(this.storage()?.getItem(OUTBOX_STORAGE_KEY) ?? null);
    if (hasDom()) {
      window.addEventListener("storage", (event) => {
        if (event.key !== OUTBOX_STORAGE_KEY) return;
        this.items = parseOutbox(event.newValue);
        this.notify();
      });
    }
  }

  private commit(next: OutboxItem[]): void {
    if (next === this.items) return;
    this.items = next;
    try {
      const storage = this.storage();
      if (next.length) storage?.setItem(OUTBOX_STORAGE_KEY, serializeOutbox(next));
      else storage?.removeItem(OUTBOX_STORAGE_KEY);
    } catch {
      /* 存满 / 隐私模式：内存里照样排着 */
    }
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** useSyncExternalStore 的快照：同一状态返回同一个数组引用。 */
  snapshot = (): OutboxItem[] => {
    this.ensureLoaded();
    return this.items;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.ensureLoaded();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** 入队并落盘；claim=true 表示本页自己马上发这一条，调度器先别碰。 */
  add(item: OutboxItem, claim = false): void {
    this.ensureLoaded();
    if (claim) this.claimed.add(item.id);
    this.commit(enqueueOutbox(this.items, item));
  }

  remove(id: string): void {
    this.ensureLoaded();
    this.claimed.delete(id);
    this.commit(removeOutbox(this.items, id));
  }

  /** 本页不再自己发了，交给调度器（可重试的失败之后调）。 */
  release(id: string): void {
    this.claimed.delete(id);
    this.kick();
  }

  retry(id: string, message: string): void {
    this.ensureLoaded();
    this.commit(markOutboxRetry(this.items, id, message));
  }

  fail(id: string, failed: NonNullable<OutboxItem["failed"]>): void {
    this.ensureLoaded();
    this.claimed.delete(id);
    this.commit(markOutboxFailed(this.items, id, failed));
  }

  get(id: string): OutboxItem | undefined {
    this.ensureLoaded();
    return this.items.find((item) => item.id === id);
  }

  registerSender(kind: OutboxKind, sender: OutboxSender): void {
    this.senders.set(kind, sender);
    this.start();
    this.kick();
  }

  /**
   * 等到这条该重发了（退避到点 / 网络恢复 / 推送流重连）或 signal 中止。
   * 给自己发着的调用方（chat 流式请求）用：它不交给调度器，而是自己等、自己重发。
   */
  waitForRetry(id: string, signal?: AbortSignal): Promise<void> {
    this.start();
    return new Promise((resolve) => {
      const item = this.get(id);
      const delay = item ? Math.max(0, item.nextAt - Date.now()) : 0;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        if (timer) clearTimeout(timer);
        this.wakers.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      timer = setTimeout(done, delay);
      this.wakers.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /** 网络回来了：退避清零，叫醒等着的调用方，立刻发一轮。 */
  wake(): void {
    this.ensureLoaded();
    this.commit(wakeOutbox(this.items));
    for (const waker of [...this.wakers]) waker();
    this.kick();
  }

  kick(): void {
    this.ensureLoaded();
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const skip = new Set([...this.inflight, ...this.claimed]);
    for (const item of dueOutbox(this.items, Date.now(), skip)) {
      const sender = this.senders.get(item.kind);
      if (sender) void this.send(item, sender);
    }
  }

  private async send(item: OutboxItem, sender: OutboxSender): Promise<void> {
    this.inflight.add(item.id);
    let result: OutboxSendResult;
    try {
      result = await sender(item);
    } catch (error) {
      result = outboxFailure(error);
    } finally {
      this.inflight.delete(item.id);
    }
    if (!this.get(item.id)) return; // 期间被撤回
    if (result.ok) {
      this.remove(item.id);
      this.kick(); // 同一 target 的下一条
    } else if (result.retry) {
      this.retry(item.id, result.message);
    } else {
      this.fail(item.id, { message: result.message, code: result.code, clearable: result.clearable });
    }
  }

  private start(): void {
    if (this.started || !hasDom()) return;
    this.started = true;
    this.ensureLoaded();
    window.addEventListener("online", () => this.wake());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.kick();
    });
    pageEvents().onStatus(({ connected }) => {
      if (connected) this.wake();
    });
    setInterval(() => this.kick(), KICK_INTERVAL_MS);
  }
}

let shared: OutboxClient | null = null;

export function outbox(): OutboxClient {
  if (!shared) {
    shared = new OutboxClient();
    // herdr 窗格输入的重发：带同一个 client_msg_id 打 /input
    shared.registerSender("herdr", async (item) => {
      try {
        const clearDraft = typeof item.payload.clearDraft === "string" ? item.payload.clearDraft : undefined;
        const result = await sendHerdrInput(item.target, item.text, clearDraft, item.id);
        if (result.status === "failed") {
          return {
            ok: false,
            retry: false,
            message: result.error ?? "消息没能送达",
            code: result.refusal?.code,
            clearable: result.refusal?.clearable,
          };
        }
        return { ok: true };
      } catch (error) {
        return outboxFailure(error);
      }
    });
  }
  return shared;
}
