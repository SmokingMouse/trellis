import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatBytes,
  readDiskWatermark,
  trellisDbPath,
  type DiskWatermark,
  type StatfsFn,
} from "@/lib/disk-space";
import { notify } from "./notify";

// S176 磁盘水位告警。auth-health.ts 的 checkAuthAlerts 是它的直接范本 ——
// 同样的「硬条件 → notify → 状态落盘去重」三段式，同样的 Record<key, ts> 状态形状，
// 只是把文件换成 disk-alerts.json（auth-alerts.json 是授权面的账本，两件事的
// 恢复条件完全不同，混在一个文件里迟早互相踩）。
//
// 告警语义（S176 返工 fix-d1 明示版，README 与这里同一套说法）：
//
//   **首次跌破阈值立即报一次；之后每 <重报间隔> 重报一次；水位回到阈值以上即
//   解除锁存（删掉 state 里的 key），于是下一次再跌破会立即重新报。**
//
// 重报而不是永久噤声是刻意的：磁盘持续告急会真的让服务写不进去，每 6h 提醒一次
// 是合理的运维行为，不是刷屏。间隔由 TRELLIS_DISK_REALERT_MS（毫秒）覆盖；
// 设成 0 就退化成「只报一次，直到恢复」的纯边沿触发（想要绝对安静的部署可以用）。
//
// 实现形状照抄 auth-health.ts 的 checkAuthAlerts —— 同样的「硬条件 → notify →
// 状态落盘去重」三段式、同样的 Record<key, ts>，只是把文件换成 disk-alerts.json
// （auth-alerts.json 是授权面的账本，两件事的恢复条件完全不同，混在一个文件里
// 迟早互相踩）。

const ALERT_STATE_PATH = path.join(os.homedir(), ".trellis", "disk-alerts.json");
const ALERT_KEY = "disk-low";

/** 默认重报间隔：6 小时。 */
export const DEFAULT_REALERT_MS = 6 * 3600_000;

/** 重报间隔。每次检查现读 env —— 改配置不必重启，测试也不用重新 import 模块。
 * 0（或负数 / 非法值以外的合法 0）= 关掉周期重报，只在恢复后再跌破时才报。 */
export function realertMs(): number {
  const raw = process.env.TRELLIS_DISK_REALERT_MS;
  if (raw === undefined || !raw.trim()) return DEFAULT_REALERT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_REALERT_MS;
}

function readAlertState(): Record<string, number> {
  try {
    const parsed = JSON.parse(fs.readFileSync(ALERT_STATE_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {}; // 没有就是从没报过
  }
}

function writeAlertState(state: Record<string, number>): void {
  fs.mkdirSync(path.dirname(ALERT_STATE_PATH), { recursive: true });
  fs.writeFileSync(ALERT_STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

export function alertBody(w: DiskWatermark): string {
  const pct = (w.freeRatio * 100).toFixed(1);
  const rule =
    w.reason === "ratio"
      ? `低于剩余 ${(w.thresholds.minFreeRatio * 100).toFixed(1)}%`
      : `低于 ${formatBytes(w.thresholds.minFreeBytes)}`;
  return (
    `${w.path} 仅剩 ${formatBytes(w.freeBytes)}（${pct}%，共 ${formatBytes(w.totalBytes)}），${rule}。\n` +
    `SQLite 写满盘会直接抛 SQLITE_FULL，提问将当场失败。请清理该分区，或把 TRELLIS_DB_PATH 指到更大的盘。`
  );
}

export type DiskAlertDeps = {
  statfs?: StatfsFn;
  dbPath?: string;
  now?: () => number;
  /** 重报间隔覆盖（毫秒，0 = 只报一次直到恢复）。缺省走 realertMs()/env。 */
  realertMs?: number;
  readState?: () => Record<string, number>;
  writeState?: (s: Record<string, number>) => void;
  send?: (e: { title: string; body: string }) => Promise<void> | void;
};

/**
 * 查一次水位，必要时告警。scheduler 启动时 + 每 5 分钟调一次。
 * 自兜异常 —— 监控本身出问题绝不能连累调度 tick。
 *
 * 语义（见文件头）：首次跌破立即报 → 之后每 realertMs() 重报一次 →
 * 回到阈值以上解除锁存 → 再跌破立即重新报。
 *
 * 返回这一轮的水位（读不出来为 null），方便调用方顺手做日志 / 断言。
 */
export async function checkDiskAlert(
  deps: DiskAlertDeps = {},
): Promise<DiskWatermark | null> {
  try {
    const w = readDiskWatermark(deps.dbPath ?? trellisDbPath(), deps.statfs);
    if (!w) return null;
    const now = (deps.now ?? Date.now)();
    const readState = deps.readState ?? readAlertState;
    const writeState = deps.writeState ?? writeAlertState;
    const state = readState();
    const lastAt = state[ALERT_KEY];

    if (!w.low) {
      // 恢复到阈值以上：解除锁存，下次再跌破立即重新报。
      if (lastAt !== undefined) {
        delete state[ALERT_KEY];
        writeState(state);
      }
      return w;
    }
    // 还在低水位：首次（lastAt 未定义）立即报；之后满一个重报间隔才再报。
    // 间隔为 0 表示关掉周期重报 —— 一直低就一直沉默，直到恢复解除锁存。
    if (lastAt !== undefined) {
      const interval = deps.realertMs ?? realertMs();
      if (interval <= 0 || now - lastAt < interval) return w;
    }

    const title = "trellis：数据库分区空间不足";
    const body = alertBody(w);
    if (deps.send) {
      await deps.send({ title, body });
    } else {
      await notify({ kind: "disk_alert", title, body });
    }
    state[ALERT_KEY] = now;
    writeState(state);
    return w;
  } catch (e) {
    console.error("[disk-watch] 水位检查失败：", e);
    return null;
  }
}
