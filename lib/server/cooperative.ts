// 协作式分片执行原语（纯函数，无 DB / 无 server-only）。
//
// 背景：transcript 解析是 CPU-bound 的纯 JS。一个 185MB 的 codex rollout 全量
// 解析要跑上百毫秒，而 watcher 每次去抖后都会跑一遍 —— 跑的时候整个 Node 事件
// 循环被钉死，HTTP 请求（包括 /login）排在后面等。
//
// 解法不是"把解析搬进 worker_thread"（见 docs 里的取舍记录：结果对象本身就大，
// postMessage 的 structured clone 在主线程上同样是一次 O(n) 阻塞，只是把阻塞从
// 解析挪到了序列化，而且解析缓存必须留在主进程），而是把解析写成 generator：
// 同一份实现，两个驱动器 ——
//   runToCompletion  同步跑完（老调用方零行为变化、零 async 开销）
//   runCooperatively 按时间片跑，片间 setImmediate 让出事件循环
//
// generator 里的 yield 只是"允许在这里被打断"的标记，不携带值；是否真的让出由
// 驱动器按 sliceMs 决定，所以 yield 可以撒得密一点而不付出让出的代价。

/** 同步驱动：一路 next() 到底，等价于把 generator 体当普通函数跑。 */
export function runToCompletion<T>(gen: Generator<void, T>): T {
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
}

/** 默认时间片：单次连续占用事件循环的上限（ms）。 */
export const DEFAULT_SLICE_MS = 12;

const yieldToEventLoop = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

/**
 * 协作驱动：每跑满 sliceMs 就让出一次事件循环。
 * 单次阻塞上限 ≈ sliceMs + 两个 yield 之间那段代码的耗时。
 */
export async function runCooperatively<T>(
  gen: Generator<void, T>,
  sliceMs: number = DEFAULT_SLICE_MS,
): Promise<T> {
  let sliceStart = performance.now();
  let step = gen.next();
  while (!step.done) {
    if (performance.now() - sliceStart >= sliceMs) {
      await yieldToEventLoop();
      sliceStart = performance.now();
    }
    step = gen.next();
  }
  return step.value;
}

/** 循环里的让出节奏：每 N 次迭代给驱动器一次打断机会。 */
export const YIELD_STRIDE = 2048;

/**
 * 给「不是 generator、但同样 CPU-bound 的 async 循环」用的时间片闸。
 *
 * 场景是 runCooperatively 覆盖不到的那些循环：枚举上千个兄弟 jsonl 并逐个采样
 * meta、逐个解析（cli-discover / cli-lineage）。这些循环里的 await 大多会命中
 * stat 短路或进程内缓存 —— 全是已 resolve 的 promise，只走 microtask，
 * **不会**把控制权交回宏任务队列，于是几百次迭代照样能把事件循环占住。
 *
 * 返回的函数每次调用检查一下本片是否跑满：没跑满立刻返回（零代价，可以撒得很
 * 密），跑满了才真的 setImmediate 让出一次。
 */
export function makeSlicer(
  sliceMs: number = DEFAULT_SLICE_MS,
): () => Promise<void> {
  let sliceStart = performance.now();
  return async () => {
    if (performance.now() - sliceStart < sliceMs) return;
    await yieldToEventLoop();
    sliceStart = performance.now();
  };
}
