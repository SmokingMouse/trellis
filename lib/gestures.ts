// 手机端手势的纯判定层（单测见 lib/gestures.test.ts）。hooks/useSwipe.ts 与各手势组件
// 只负责接事件、改样式；方向锁定、阈值、高风险命令、撤销定时都在这里，可以脱离 DOM 测。

export type SwipeAxis = "x" | "y";

/** 起手多少 px 以内不判方向（手指抖动）。 */
export const AXIS_LOCK_SLOP = 10;
/**
 * 水平判定的角度上限：|dy| ≤ |dx| · tan(35°) 才算水平，其余一律算纵向——
 * 纵向滚动优先，斜着划默认是在翻正文。
 */
export const HORIZONTAL_MAX_SLOPE = 0.7;

/**
 * 方向锁定：位移不足 slop 返回 null（继续观察）；一旦返回就不再改（调用方负责锁住）。
 * 斜向划动按「纵向优先」归到 y。
 */
export function lockAxis(dx: number, dy: number, slop = AXIS_LOCK_SLOP): SwipeAxis | null {
  if (Math.hypot(dx, dy) < slop) return null;
  return Math.abs(dy) <= Math.abs(dx) * HORIZONTAL_MAX_SLOPE ? "x" : "y";
}

export type SwipeThreshold = {
  /** 距离阈值：占容器尺寸的比例 */
  ratio: number;
  /** 距离阈值下限 px（容器很窄时也要划够这么远） */
  minDistance: number;
  /** 速度阈值 px/ms：快速甩动时距离不够也触发 */
  velocity: number;
  /** 甩动至少要这么远 px，避免轻点带出的抖动被当成甩动 */
  minFlingDistance: number;
};

export const DEFAULT_SWIPE_THRESHOLD: SwipeThreshold = {
  ratio: 0.28,
  minDistance: 64,
  velocity: 0.5,
  minFlingDistance: 32,
};

/**
 * 松手时是否触发：返回 1（正方向）、-1（负方向）或 0（回弹）。
 * 过距离阈值直接触发；距离不够但速度够且与位移同向也触发。
 */
export function swipeCommit(
  input: { delta: number; velocity: number; size: number },
  threshold: SwipeThreshold = DEFAULT_SWIPE_THRESHOLD,
): -1 | 0 | 1 {
  const { delta, velocity, size } = input;
  if (delta === 0) return 0;
  const sign = delta > 0 ? 1 : -1;
  const distance = Math.max(threshold.minDistance, size * threshold.ratio);
  if (Math.abs(delta) >= distance) return sign;
  if (
    Math.abs(delta) >= threshold.minFlingDistance &&
    Math.abs(velocity) >= threshold.velocity &&
    Math.sign(velocity) === sign
  ) {
    return sign;
  }
  return 0;
}

/** 没有下一个 / 不允许时的阻尼位移：越拉越沉，最多 limit px。 */
export function rubberBand(delta: number, limit = 48): number {
  if (delta === 0) return 0;
  const sign = delta > 0 ? 1 : -1;
  const d = Math.abs(delta);
  return sign * (limit * d) / (d + limit * 2);
}

/** 由最近的采样点估算速度（px/ms），只看最后 windowMs 内的样本。 */
export function velocityFrom(samples: { t: number; v: number }[], windowMs = 100): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = samples[0];
  for (let i = samples.length - 2; i >= 0; i--) {
    first = samples[i];
    if (last.t - samples[i].t >= windowMs) break;
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.v - first.v) / dt : 0;
}

// ── 起点冲突 ────────────────────────────────────────────────────────────

export type ScrollBox = {
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  parentElement: ScrollBox | null;
  matches?: (selector: string) => boolean;
};

/** 从 start 往上走到 stop（不含），找第一个满足 test 的元素。 */
function walkUp<T extends ScrollBox>(start: T | null, stop: ScrollBox | null, test: (el: T) => boolean): boolean {
  for (let el: T | null = start; el && el !== stop; el = el.parentElement as T | null) {
    if (test(el)) return true;
  }
  return false;
}

const SCROLLABLE = /^(auto|scroll)$/;

/**
 * 起点在可横向滚动的元素里（代码块、表格、窗格条）或显式标了 data-swipe-ignore → 不接管，
 * 让它自己横滚。只认「真的能滚」的：overflow-x 是 auto/scroll 且内容比盒子宽。
 */
export function startsInHorizontalScroller<T extends ScrollBox>(
  target: T | null,
  root: ScrollBox | null,
  overflowX: (el: T) => string,
): boolean {
  return walkUp(target, root, (el) => {
    if (el.matches?.("[data-swipe-ignore]")) return true;
    return el.scrollWidth > el.clientWidth + 1 && SCROLLABLE.test(overflowX(el));
  });
}

/** 起点所在的内层纵向滚动盒还没滚到顶（下拉手势应让它先滚）。 */
export function startsInScrolledInner<T extends ScrollBox>(
  target: T | null,
  root: ScrollBox | null,
  overflowY: (el: T) => string,
): boolean {
  return walkUp(target, root, (el) =>
    el.scrollHeight > el.clientHeight + 1 && SCROLLABLE.test(overflowY(el)) && el.scrollTop > 0,
  );
}

/** 左边缘起手：距屏幕左缘 edge px 以内。 */
export const EDGE_SWIPE_WIDTH = 20;
export function isEdgeStart(clientX: number, edge = EDGE_SWIPE_WIDTH): boolean {
  return clientX >= 0 && clientX <= edge;
}

/** 下拉打开终端：只有正文已在顶部、且往下拉时才算。 */
export const PULL_OPEN_DISTANCE = 72;
export function pullDistance(rawDy: number, max = 120): number {
  if (rawDy <= 0) return 0;
  // 手指走 1px，指示走 ~0.5px，越往下越沉
  return Math.min(max, rawDy * 0.55);
}

// ── 高风险命令 ──────────────────────────────────────────────────────────

// 只要命中一条就不响应滑动放行 / 拒绝，只能点按钮。宁可多拦：误拦的代价是多点一下，
// 漏拦的代价是一次手滑推了远端 / 删了文件。匹配对象是审批卡的整段文字（工具名 + 命令 + 标题）。
const HIGH_RISK_PATTERNS: { id: string; re: RegExp }[] = [
  { id: "git push", re: /\bgit\b[^\n;&|]*\bpush\b/i },
  { id: "git reset --hard", re: /\bgit\b[^\n;&|]*\breset\b[^\n;&|]*--hard\b/i },
  { id: "git clean", re: /\bgit\b[^\n;&|]*\bclean\b/i },
  { id: "git branch -D", re: /\bgit\b[^\n;&|]*\bbranch\b[^\n;&|]*\s-(D|-delete)\b/ },
  { id: "git checkout/restore 丢改动", re: /\bgit\b[^\n;&|]*\b(checkout|restore)\b[^\n;&|]*\s(--\s|\.(\s|$)|--staged|--worktree)/i },
  { id: "rm", re: /(^|[\s;&|(`$"'])(sudo\s+)?(rm|rmdir|unlink|shred)(\s|$)/im },
  { id: "find -delete", re: /\bfind\b[^\n]*\s-delete\b/i },
  { id: "drop", re: /\bdrop\b|\bdropdb\b/i },
  { id: "truncate", re: /\btruncate\b/i },
  { id: "delete from", re: /\bdelete\s+from\b/i },
  { id: "deploy", re: /\bdeploy/i },
  { id: "publish", re: /\b(npm|bun|pnpm|yarn|cargo|twine|gem)\b[^\n;&|]*\bpublish\b/i },
  { id: "force", re: /\bforce\b|--force/i },
  { id: "destroy", re: /\bdestroy\b/i },
  { id: "kubectl delete", re: /\bkubectl\b[^\n;&|]*\b(delete|drain)\b/i },
  { id: "sudo", re: /(^|[\s;&|(])sudo\s/m },
  { id: "mkfs / dd", re: /\bmkfs\b|(^|\s)dd\s+[^\n]*\bof=/m },
  { id: "chmod/chown -R", re: /\b(chmod|chown)\b[^\n;&|]*\s-R\b/ },
  { id: "kill", re: /\b(kill\s+-9|pkill|killall)\b/i },
  { id: "shutdown", re: /\b(shutdown|reboot|halt)\b/i },
  { id: "管道进 shell", re: /\|\s*(sudo\s+)?(ba|z)?sh\b/i },
  { id: "写 /dev", re: />\s*\/dev\/(?!null\b)/i },
];

/** 返回命中的规则名（多个），没命中返回空数组。 */
export function highRiskMatches(text: string | null | undefined): string[] {
  if (!text) return [];
  return HIGH_RISK_PATTERNS.filter(({ re }) => re.test(text)).map(({ id }) => id);
}

export function isHighRiskCommand(text: string | null | undefined): boolean {
  return highRiskMatches(text).length > 0;
}

// ── 撤销窗口 ────────────────────────────────────────────────────────────

export const SWIPE_UNDO_MS = 3_000;

export type Scheduler = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const realScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type DeferredAction = {
  /** 撤销：窗口期内调用 → 永不执行 run，返回 true；已执行 / 已撤销返回 false */
  cancel: () => boolean;
  /** 立刻执行（测试 / 用户再点一次确认用）；已结束返回 false */
  flush: () => boolean;
  state: () => "pending" | "ran" | "cancelled";
};

/**
 * 延迟执行 + 撤销：窗口期内什么都不发，到时才跑 run。和 lib/undoable.ts 的删除不同，
 * 这里关页面（pagehide）不补发——发往终端的按键宁可不发，也不在用户看不见时发。
 */
export function deferAction(
  run: () => void,
  opts: { delayMs?: number; onCancel?: () => void; scheduler?: Scheduler } = {},
): DeferredAction {
  const scheduler = opts.scheduler ?? realScheduler;
  let state: "pending" | "ran" | "cancelled" = "pending";
  const fire = () => {
    if (state !== "pending") return false;
    state = "ran";
    scheduler.clear(handle);
    run();
    return true;
  };
  const handle = scheduler.set(fire, opts.delayMs ?? SWIPE_UNDO_MS);
  return {
    cancel: () => {
      if (state !== "pending") return false;
      state = "cancelled";
      scheduler.clear(handle);
      opts.onCancel?.();
      return true;
    },
    flush: fire,
    state: () => state,
  };
}
