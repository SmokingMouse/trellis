import "server-only";
import fs from "node:fs";

// S88: 通用的「一组目录 → 变化回调」监听池。
//
// 结构抄自 lib/server/cli-sync-watcher.ts（fs.watch + watchers Map + debounce Map
// + refresh 语义），但**不复用它** —— 那份的两个 Map 与 CLI attach 集合强耦合
// （实时查 DB 决定监听谁）。把它重构成通用池是纯风险零收益，所以抽形状不抽代码。
//
// **只监听单层目录**（不 recursive）：macOS 的 recursive watch 可用，但 Linux
// （BOE）的 recursive 是 Node 20+ 才有、且实现是 walk 出来的，大目录很贵。
// 想监听整个 repo 请用 git 触发器。

export type WatchSpec = {
  /** 稳定标识（用 trigger id）。sync 时按它 diff。 */
  key: string;
  dir: string;
  /** 文件名过滤。返回 false 的变化被忽略。 */
  filter?: (name: string) => boolean;
  debounceMs: number;
  onChange: (file: string) => void;
};

export type WatchPool = {
  sync(specs: WatchSpec[]): void;
  stopAll(): void;
};

export function createWatchPool(label = "watch-pool"): WatchPool {
  const watchers = new Map<string, fs.FSWatcher>();
  const debounces = new Map<string, ReturnType<typeof setTimeout>>();

  function stop(key: string) {
    watchers.get(key)?.close();
    watchers.delete(key);
    for (const [k, t] of debounces) {
      if (k.startsWith(`${key}::`)) {
        clearTimeout(t);
        debounces.delete(k);
      }
    }
  }

  return {
    sync(specs) {
      const want = new Set(specs.map((s) => s.key));
      for (const key of [...watchers.keys()]) {
        if (!want.has(key)) stop(key);
      }
      for (const spec of specs) {
        if (watchers.has(spec.key)) continue; // 已在监听（dir 变了要先删 trigger）
        try {
          const w = fs.watch(spec.dir, (_event, filename) => {
            if (!filename) return;
            const name = String(filename);
            if (spec.filter && !spec.filter(name)) return;
            // 一次保存能触发多个 fs 事件（写入 + 元数据 + 编辑器的临时文件搬运），
            // 去抖是必须的，否则一次编辑跑三遍任务。
            const dk = `${spec.key}::${name}`;
            const prev = debounces.get(dk);
            if (prev) clearTimeout(prev);
            debounces.set(
              dk,
              setTimeout(() => {
                debounces.delete(dk);
                try {
                  spec.onChange(name);
                } catch (e) {
                  console.error(`[${label}] onChange 抛错（${spec.dir}/${name}）：`, e);
                }
              }, spec.debounceMs),
            );
          });
          w.on("error", (e) => {
            console.warn(`[${label}] watcher 出错，停止监听 ${spec.dir}：`, e);
            stop(spec.key);
          });
          watchers.set(spec.key, w);
        } catch (e) {
          // 目录不存在 / 无权限 —— 只 warn，绝不拦住其它监听。
          console.warn(`[${label}] 无法监听 ${spec.dir}：`, e);
        }
      }
    },
    stopAll() {
      for (const key of [...watchers.keys()]) stop(key);
    },
  };
}
