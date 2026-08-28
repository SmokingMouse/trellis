/**
 * 进程内异步信号量。release 有等待者时把现有槽位直接交接，不先归还公共池；
 * 否则 waiter 恢复前的新 acquire 会从短暂的空位偷槽，实际并发突破上限。
 */
export class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("semaphore limit must be positive");
  }

  get activeCount(): number {
    return this.active;
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    // 被唤醒时槽位已经由 release 原子交接，不能再自增。
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    if (this.active <= 0) throw new Error("semaphore released without an active permit");
    this.active--;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
