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
// 去重是**边沿触发**的：跌破阈值报一次，之后每轮沉默；水位回到阈值以上就把 key
// 删掉，于是下一次再跌破可以重新报。同时留一条 6h 冷却 —— 一直不清盘的话，
// 每 6 小时提醒一次比彻底噤声好（磁盘满是会真的让服务写不进去的）。

const ALERT_STATE_PATH = path.join(os.homedir(), ".trellis", "disk-alerts.json");
const ALERT_KEY = "disk-low";
const REALERT_MS = 6 * 3600_000;

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
  readState?: () => Record<string, number>;
  writeState?: (s: Record<string, number>) => void;
  send?: (e: { title: string; body: string }) => Promise<void> | void;
};

/**
 * 查一次水位，必要时告警。scheduler 启动时 + 每 5 分钟调一次。
 * 自兜异常 —— 监控本身出问题绝不能连累调度 tick。
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
      // 恢复：清掉 key，下次再跌破可以重新报（这就是「边沿」）。
      if (lastAt !== undefined) {
        delete state[ALERT_KEY];
        writeState(state);
      }
      return w;
    }
    if (lastAt !== undefined && now - lastAt < REALERT_MS) return w;

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
