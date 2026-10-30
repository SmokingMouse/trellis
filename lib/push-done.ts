// 「已完成」推送的延迟裁决（纯逻辑，时钟 / 定时器 / 现场探测全部注入，bun test 用假时钟测）。
//
// 推送是给不在电脑前的人看的，所以一轮结束不立刻推（思路借自 chyroc/jarvis 的
// turnTracker，只借规则不借代码）：
//   - 结束后等 delayMs（默认 60s）再决定；这段时间里用户看过它（前台心跳 / 已读）、
//     或它又开始干活，就不推；
//   - 结束时还有后台任务（后台 Bash / 异步子 agent）在跑 = 活没干完：先挂起，等这批
//     任务回报、由回报唤起的那一轮真正结束时再推；挂起超过 holdMs 放弃；
//   - 由后台任务回报唤起、但之前并没有挂起的一轮（例如重启后、或上一轮已经推过）不推，
//     免得同一件事推两次。
//
// 定时器只在内存里：服务重启丢了就丢了（宁可漏一条，不能重复推）。

export const PUSH_DONE_DELAY_MS = 60_000;
export const PUSH_DONE_HOLD_MS = 2 * 60 * 60_000;

/** TRELLIS_PUSH_DONE_DELAY_MS 可覆盖延迟（验收 / 调试时缩短）；非法值回落默认。 */
export function doneDelayFromEnv(env: Record<string, string | undefined> = process.env): number {
  const text = env.TRELLIS_PUSH_DONE_DELAY_MS?.trim();
  if (!text) return PUSH_DONE_DELAY_MS;
  const raw = Number(text);
  return Number.isFinite(raw) && raw >= 0 ? raw : PUSH_DONE_DELAY_MS;
}

/** 到点时的现场。由调用方现查（DB / fleet / transcript），越晚查越准。 */
export type DoneProbe = {
  /** working = 又在干活（这次作废，等它下一次结束）；gone = 会话 / 窗格没了。 */
  status: "done" | "working" | "gone";
  /** 结束之后用户看过（已读标记 / 别处的已读信号）。前台心跳另由 seen() 喂。 */
  seen?: boolean;
  /** 还有后台任务在跑。 */
  background?: boolean;
  /** 这一轮是后台任务回报唤起的（不是人发起的）。 */
  wokeByTask?: boolean;
};

export type DoneVerdict = "stale" | "drop" | "hold" | "push";

export type DoneTimers = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export const realDoneTimers: DoneTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    // 别让一个待推的定时器拖住进程退出（测试 / 关服）。
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

type Turn<T> = {
  gen: number;
  /** 挂起的起点（第一次因后台任务挂起的那一轮的结束时刻）。 */
  heldSince: number | null;
  seen: boolean;
  /** 前台心跳用的会话 id（没绑会话的 Herdr 窗格为 null）。 */
  presenceId: string | null;
  timer: unknown;
  info: T;
};

export type DoneSchedulerOptions<T> = {
  timers?: DoneTimers;
  delayMs?: number | (() => number);
  holdMs?: number;
  /** 到点现查现场。抛错按 drop 处理。 */
  probe: (key: string, info: T) => DoneProbe;
  /** 裁决为 push 时调用（门槛 / 前台 / 去重仍由调用方的出口再判一次）。 */
  deliver: (key: string, info: T) => void;
};

export class DoneScheduler<T> {
  private readonly turns = new Map<string, Turn<T>>();
  private readonly timers: DoneTimers;

  constructor(private readonly options: DoneSchedulerOptions<T>) {
    this.timers = options.timers ?? realDoneTimers;
  }

  private delay(): number {
    const d = this.options.delayMs;
    return typeof d === "function" ? d() : (d ?? PUSH_DONE_DELAY_MS);
  }

  /** 一轮结束：delayMs 后裁决。同一 key 的上一次待裁决作废（只认最新一次结束）。 */
  ended(key: string, info: T, presenceId: string | null): void {
    const prev = this.turns.get(key);
    if (prev?.timer !== undefined && prev.timer !== null) this.timers.clearTimeout(prev.timer);
    const turn: Turn<T> = {
      gen: (prev?.gen ?? 0) + 1,
      heldSince: prev?.heldSince ?? null,
      seen: false,
      presenceId,
      timer: null,
      info,
    };
    this.turns.set(key, turn);
    const gen = turn.gen;
    turn.timer = this.timers.setTimeout(() => this.settle(key, gen), this.delay());
  }

  /** 又开始干活：待裁决的那次作废；挂起状态保留（等这一轮结束再判）。 */
  working(key: string): void {
    const turn = this.turns.get(key);
    if (!turn) return;
    if (turn.timer !== null) this.timers.clearTimeout(turn.timer);
    turn.timer = null;
    turn.gen++;
    if (turn.heldSince === null) this.turns.delete(key);
  }

  /** 不再需要推（例如转成了「需要你」，那条推送会顶掉它）：连挂起一起清掉。 */
  cancel(key: string): void {
    const turn = this.turns.get(key);
    if (!turn) return;
    if (turn.timer !== null) this.timers.clearTimeout(turn.timer);
    this.turns.delete(key);
  }

  /** 前台心跳：这个会话被看了一眼 → 它名下待裁决的那次不推。 */
  seen(presenceId: string): void {
    for (const turn of this.turns.values()) {
      if (turn.presenceId === presenceId && turn.timer !== null) turn.seen = true;
    }
  }

  has(key: string): boolean {
    return this.turns.has(key);
  }

  /** 到点裁决。导出给测试直接断言；正常由定时器调。 */
  settle(key: string, gen: number): DoneVerdict {
    const turn = this.turns.get(key);
    if (!turn || turn.gen !== gen) return "stale";
    turn.timer = null;
    let probe: DoneProbe;
    try {
      probe = this.options.probe(key, turn.info);
    } catch (err) {
      console.warn("[push] 完成推送现场探测失败：", err);
      this.turns.delete(key);
      return "drop";
    }
    if (probe.status === "working") return "stale";
    if (probe.status === "gone" || turn.seen || probe.seen) {
      this.turns.delete(key);
      return "drop";
    }
    const now = this.timers.now();
    if (probe.background) {
      const since = turn.heldSince ?? now;
      if (now - since > (this.options.holdMs ?? PUSH_DONE_HOLD_MS)) {
        this.turns.delete(key);
        return "drop";
      }
      turn.heldSince = since;
      return "hold";
    }
    const held = turn.heldSince !== null;
    this.turns.delete(key);
    if (probe.wokeByTask && !held) return "drop";
    this.options.deliver(key, turn.info);
    return "push";
  }
}
