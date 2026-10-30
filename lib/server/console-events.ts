import "server-only";

// Herdr 控制台变更的统一事件源：Herdr socket 事件（窗格 / 布局 / 输入投递）、
// hook 状态写入、transcript 镜像变化，任一发生都在一个固定窗口内合并，
// 算一次 fleet / hook 两个 ETag，**变了才**广播一条失效通知。
//
// 推的是「新 ETag + 变更来源」而不是全量：真实 fleet ≈ 127 KB（其中 110 KB 是
// 历史绑定），每个窗格状态跳一下就往每个标签页推 127 KB 不划算；客户端拿 ETag
// 比对后带 If-None-Match 拉一次（本机 ~12 ms），没变的那半边根本不发请求。

export type ConsoleChangeKind = "herdr" | "hook" | "transcript";

export type ConsoleChange = {
  type: "changed";
  fleetEtag: string | null;
  hooksEtag: string | null;
  kinds: ConsoleChangeKind[];
};

type Listener = (change: ConsoleChange) => void;

export type ConsoleHubOptions = {
  fleetEtag: () => string | null;
  hooksEtag: () => string | null;
  /** 合并窗口：第一条触发起算，窗口内的后续触发不再顺延（上限延迟 = coalesceMs）。 */
  coalesceMs?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
};

export const CONSOLE_COALESCE_MS = 100;

export class ConsoleHub {
  private readonly listeners = new Set<Listener>();
  private pending = new Set<ConsoleChangeKind>();
  private scheduled = false;
  private last: { fleetEtag: string | null; hooksEtag: string | null } | null = null;

  constructor(private readonly options: ConsoleHubOptions) {}

  get size(): number {
    return this.listeners.size;
  }

  /** 当前 ETag 对（新连接的首帧用它，让客户端立刻知道自己是否落后）。 */
  current(): ConsoleChange {
    const snapshot = this.compute();
    return { type: "changed", ...snapshot, kinds: [] };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  notify(kind: ConsoleChangeKind): void {
    // 没人订阅就不算 ETag：hook 路由挂在每次工具调用前后，必须零成本。
    if (this.listeners.size === 0) return;
    this.pending.add(kind);
    if (this.scheduled) return;
    this.scheduled = true;
    (this.options.schedule ?? setTimeout)(() => this.flush(), this.options.coalesceMs ?? CONSOLE_COALESCE_MS);
  }

  private compute(): { fleetEtag: string | null; hooksEtag: string | null };
  private compute(fleet: boolean, hooks: boolean): { fleetEtag: string | null | undefined; hooksEtag: string | null | undefined };
  private compute(fleet = true, hooks = true) {
    const safe = (fn: () => string | null) => {
      try { return fn(); } catch { return null; }
    };
    return {
      fleetEtag: fleet ? safe(this.options.fleetEtag) : undefined,
      hooksEtag: hooks ? safe(this.options.hooksEtag) : undefined,
    };
  }

  flush(): void {
    this.scheduled = false;
    const kinds = [...this.pending];
    this.pending = new Set();
    if (this.listeners.size === 0 || kinds.length === 0) return;
    // 只重算可能变了的那半边：hook 表只经 hook 路由写（过期清理由客户端 30s 兜底轮询
    // 带出），transcript 的 fs 事件在 CLI 流式输出时很密，别每 100ms 都去扫 hook 表。
    let next: { fleetEtag: string | null; hooksEtag: string | null };
    if (!this.last) next = this.compute();
    else {
      const fresh = this.compute(kinds.some(k => k !== "hook"), kinds.includes("hook"));
      next = {
        fleetEtag: fresh.fleetEtag === undefined ? this.last.fleetEtag : fresh.fleetEtag,
        hooksEtag: fresh.hooksEtag === undefined ? this.last.hooksEtag : fresh.hooksEtag,
      };
    }
    if (this.last && this.last.fleetEtag === next.fleetEtag && this.last.hooksEtag === next.hooksEtag) return;
    this.last = next;
    const change: ConsoleChange = { type: "changed", ...next, kinds };
    for (const listener of [...this.listeners]) {
      try { listener(change); } catch { this.listeners.delete(listener); }
    }
  }
}

const shared = globalThis as typeof globalThis & {
  __trellisConsoleHub?: ConsoleHub;
  __trellisConsoleTaps?: Set<(kind: ConsoleChangeKind) => void>;
};
const taps = (shared.__trellisConsoleTaps ??= new Set());

/** 已建好的 hub（没人开过 /api/events 时为 null —— 此时通知直接丢弃）。 */
export function consoleHub(): ConsoleHub | null {
  return shared.__trellisConsoleHub ?? null;
}

export function installConsoleHub(create: () => ConsoleHub): ConsoleHub {
  return (shared.__trellisConsoleHub ??= create());
}

export function notifyConsoleChange(kind: ConsoleChangeKind): void {
  // 服务端旁听（Herdr 的 Web Push，lib/server/herdr-push.ts）：不依赖有没有页面连着
  // /api/events。旁听者自己负责合并与降本，这里只转一下。
  for (const tap of taps) {
    try { tap(kind); } catch { /* 旁听者的问题不影响 hook 应答 */ }
  }
  shared.__trellisConsoleHub?.notify(kind);
}

/** 旁听所有变更通知（含没人订阅 /api/events 时）。返回退订函数。 */
export function tapConsoleChanges(listener: (kind: ConsoleChangeKind) => void): () => void {
  taps.add(listener);
  return () => { taps.delete(listener); };
}
