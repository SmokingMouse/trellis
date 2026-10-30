// 单测用的假时钟（实现 lib/push-done.ts 的 DoneTimers）：advance(ms) 按到期顺序同步触发定时器。
import type { DoneTimers } from "../push-done";

export class FakeTimers implements DoneTimers {
  private t: number;
  private seq = 0;
  private readonly queue = new Map<number, { at: number; fn: () => void }>();

  constructor(start = 1_000_000) {
    this.t = start;
  }

  now = (): number => this.t;

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.queue.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.queue.delete(handle as number);
  };

  get pending(): number {
    return this.queue.size;
  }

  /** 时间前进 ms，期间到期的定时器按时间顺序跑（回调里新设的、落在窗口内的也会跑）。 */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.queue) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      this.queue.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
  }
}
