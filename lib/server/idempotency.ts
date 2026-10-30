// 发送幂等：客户端给每条消息生成 client_msg_id（Outbox 重发沿用同一个），服务端在 TTL 内按它去重 ——
// 第一次的请求还在跑就等它，跑完了就直接回它的结果，不再打一遍字 / 不再起一轮。
//
// 第一次失败得「什么都没发生」（读屏拒发、Herdr 不可用、排队满）时应该忘掉这个 id，让重发真的再试一次；
// 由调用方用 forgetOnError 判定。其余失败（可能已经打了一半）在 TTL 内照样回同一个错。
//
// 进程内存即可：去重只防「同一条消息的自动重发 / 响应丢了重试」，重启后 Outbox 的重发本来就该真发。
// 纯逻辑，时钟可注入，单测见 idempotency.test.ts。

export const IDEMPOTENCY_TTL_MS = 10 * 60_000;

type Entry<T> = { at: number; promise: Promise<T> };

export class IdempotencyCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs = IDEMPOTENCY_TTL_MS,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 2_000,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /** TTL 内已有的那一次（还在跑或已跑完）；没有 / 过期返回 undefined。 */
  peek(key: string): Promise<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.promise;
  }

  /**
   * 同一个 key 在 TTL 内只真正执行一次 fn：并发的和后来的重复请求拿到同一个 promise（同一个结果 / 同一个错）。
   * forgetOnError(error) 为 true 时第一次失败后删掉记录，下一次重复请求会重新执行。
   */
  run(key: string, fn: () => Promise<T>, forgetOnError: (error: unknown) => boolean = () => false): Promise<T> {
    const existing = this.peek(key);
    if (existing) return existing;
    this.prune();
    const promise = fn();
    const entry: Entry<T> = { at: this.now(), promise };
    this.entries.set(key, entry);
    promise.catch((error) => {
      if (forgetOnError(error) && this.entries.get(key) === entry) this.entries.delete(key);
    });
    return promise;
  }

  /** 手动记一条（结果在别处产生时用，如 chat 的 created 事件）。 */
  set(key: string, promise: Promise<T>): void {
    this.prune();
    this.entries.set(key, { at: this.now(), promise });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /** 清掉过期的；超出上限时从最早的开始丢（Map 按插入顺序）。 */
  prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.at >= this.ttlMs) this.entries.delete(key);
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/** client_msg_id 的合法形状：1–64 个可见 ASCII（uuid / 时间戳拼随机串）。 */
export function isClientMsgId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(value);
}
