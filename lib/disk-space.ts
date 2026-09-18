// DB 所在分区的水位读数（S176）。
//
// 刻意**不带** "server-only"：/__gate/health 跑在大门进程（server.ts，裸 bun 跑，
// 没有 Next 的 server-only 运行时），它要能直接 import 这一层。所以这里只有
// statfs 和纯计算，没有 DB、没有 notify —— 告警那半边住在 lib/server/disk-watch.ts。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatBytes } from "./format-bytes";

/** DB 文件路径。sqlite.ts 的 dbPath() 从这里取，单一真源 —— 水位查错分区
 * （比如只看 $HOME 而 TRELLIS_DB_PATH 指在别的盘）是这类监控最典型的假绿。 */
export function trellisDbPath(): string {
  return (
    process.env.TRELLIS_DB_PATH || path.join(os.homedir(), ".trellis", "data.db")
  );
}

export type DiskSpace = {
  /** 实际做 statfs 的路径（DB 目录；DB 文件本身可能还不存在）。 */
  path: string;
  totalBytes: number;
  /** 非特权用户可用的字节数（bavail，不是 bfree —— root 预留块不算我们能用的）。 */
  freeBytes: number;
  /** 可用占比，0–1。total 为 0 时取 1（读不出来不当成告警）。 */
  freeRatio: number;
};

export type DiskWatermark = DiskSpace & {
  low: boolean;
  /** 触发判据，未触发为 null。 */
  reason: "ratio" | "bytes" | null;
  thresholds: { minFreeRatio: number; minFreeBytes: number };
};

/**
 * 默认阈值：**低水位兜底**，不是「能提前预警本次事故」的保证。
 *
 * 说清楚这条（fix-d1 修正）：BOE 现场 /data00 是剩 31GiB / 6% 的形状，用这对默认
 * 值算 `low=false` —— 6% > 5%，31GiB > 2GiB，两条判据都不触发。也就是说这次事故
 * **不会**被默认阈值提前预警。SQLITE_FULL 也不总是「盘真的写满了」：配额、inode、
 * 单分区突发写入都能在水位看着还行的时候把写打死。
 *
 * 默认值的实际用途是「盘确实快见底了给个提醒」，覆盖不到的场景靠两条 env 按实际
 * 分区/配额调（TRELLIS_DISK_MIN_FREE_PCT / TRELLIS_DISK_MIN_FREE_BYTES）。大盘
 * 建议配置示例见本单 out/README.md 的「m1」一节（devbox 那种 500GiB 起步的盘，
 * 5% 太晚，建议把 PCT 抬到 10–15）。
 */
export const DEFAULT_MIN_FREE_RATIO = 0.05;
export const DEFAULT_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

export { formatBytes };

function envNumber(name: string): number | null {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function diskThresholds(): {
  minFreeRatio: number;
  minFreeBytes: number;
} {
  // TRELLIS_DISK_MIN_FREE_PCT 收百分数（5 = 5%），MIN_FREE_BYTES 收字节。
  const pct = envNumber("TRELLIS_DISK_MIN_FREE_PCT");
  return {
    minFreeRatio: pct === null ? DEFAULT_MIN_FREE_RATIO : pct / 100,
    minFreeBytes:
      envNumber("TRELLIS_DISK_MIN_FREE_BYTES") ?? DEFAULT_MIN_FREE_BYTES,
  };
}

export type StatfsLike = {
  bsize: number;
  blocks: number;
  bavail: number;
};

/** 可注入的 statfs（测试用假读数；生产是 node:fs 的同步 statfs）。 */
export type StatfsFn = (p: string) => StatfsLike;

const realStatfs: StatfsFn = (p) => fs.statfsSync(p);

/** 读一次水位。读不出来（路径不存在 / 平台不支持）返回 null —— 监控自己挂了
 * 绝不能变成「服务挂了」，调用方按「未知」处理。 */
export function readDiskSpace(
  target: string = trellisDbPath(),
  statfs: StatfsFn = realStatfs,
): DiskSpace | null {
  // DB 文件可能还没被创建，但它的目录一定在（getDB 会 mkdirSync）。
  const dir = path.dirname(target);
  try {
    const st = statfs(dir);
    const bsize = Number(st.bsize) || 0;
    const totalBytes = bsize * Number(st.blocks || 0);
    const freeBytes = bsize * Number(st.bavail || 0);
    return {
      path: dir,
      totalBytes,
      freeBytes,
      freeRatio: totalBytes > 0 ? freeBytes / totalBytes : 1,
    };
  } catch {
    return null;
  }
}

export function evaluateWatermark(space: DiskSpace): DiskWatermark {
  const thresholds = diskThresholds();
  // 两条判据取「或」：小盘靠比例、大盘靠绝对值。只留一条的话，2T 的盘 5% 还有
  // 100G（太晚才报警没意义的反面：太早），而 20G 的小盘 2GiB 就是 10%（永远在报）。
  const byRatio = space.freeRatio < thresholds.minFreeRatio;
  const byBytes = space.freeBytes < thresholds.minFreeBytes;
  return {
    ...space,
    low: byRatio || byBytes,
    reason: byRatio ? "ratio" : byBytes ? "bytes" : null,
    thresholds,
  };
}

export function readDiskWatermark(
  target: string = trellisDbPath(),
  statfs: StatfsFn = realStatfs,
): DiskWatermark | null {
  const space = readDiskSpace(target, statfs);
  return space ? evaluateWatermark(space) : null;
}

/** /__gate/health 与告警正文共用的紧凑形状。 */
export function diskHealthField(
  target: string = trellisDbPath(),
  statfs: StatfsFn = realStatfs,
): {
  path: string;
  freeBytes: number;
  totalBytes: number;
  freePct: number | null;
  low: boolean | null;
} {
  const w = readDiskWatermark(target, statfs);
  if (!w) {
    return {
      path: path.dirname(target),
      freeBytes: 0,
      totalBytes: 0,
      freePct: null, // null = 读不出来，区别于 0
      low: null,
    };
  }
  return {
    path: w.path,
    freeBytes: w.freeBytes,
    totalBytes: w.totalBytes,
    freePct: Math.round(w.freeRatio * 1000) / 10,
    low: w.low,
  };
}
