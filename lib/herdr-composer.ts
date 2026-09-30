// HerdrComposer 的纯逻辑（便于单测）：提示文案、路径插入、排队列表与服务端回执对账。
import type { HerdrInputDelivery } from "./herdr-input";
import { sendHint, type SendKey } from "./send-key";

/** 与常规输入框同构的快捷键提示行。 */
export function herdrComposerHint(sendKey: SendKey): string {
  return `${sendHint(sendKey)} · 输入 / 调出 Claude 命令 · 可粘贴图片`;
}

/** 路径含空格时加引号 —— Claude Code 按空白切词认路径。 */
export function quotePath(path: string): string {
  return /\s/.test(path) ? `"${path.replaceAll('"', '\\"')}"` : path;
}

/**
 * 把附件的绝对路径插到光标处：两侧不贴着非空白字符（左右各补一个空格），
 * 返回新文本与插入后的光标位置。caret 越界时按文末处理。
 */
export function insertPathAt(
  text: string,
  path: string,
  caret: number | null | undefined,
): { text: string; caret: number } {
  const at = caret == null || caret < 0 || caret > text.length ? text.length : caret;
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : after ? "" : " ";
  const inserted = `${lead}${quotePath(path)}${trail}`;
  return { text: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}

export type HerdrQueuedInput = {
  inputId: string;
  paneId: string;
  text: string;
  /** 本地入队时间：服务端重启丢了回执时，据此判定过期 */
  queuedAt: number;
};

/**
 * 排队列表 × fleet 回执对账：
 *   queued     → 留在列表；
 *   delivered  → 移除；
 *   cancelled  → 移除（撤回时文本已放回输入框）；
 *   failed     → 移除，文本交还调用方放回输入框；
 *   回执缺失   → 超过 staleMs（服务端重启、回执被淘汰）视同失败，文本同样交还。
 */
export function reconcileHerdrQueue(
  queue: HerdrQueuedInput[],
  deliveries: HerdrInputDelivery[] | undefined,
  now: number,
  staleMs = 15_000,
): { queue: HerdrQueuedInput[]; failed: HerdrQueuedInput[]; delivered: HerdrQueuedInput[] } {
  const byId = new Map((deliveries ?? []).map((d) => [d.inputId, d]));
  const keep: HerdrQueuedInput[] = [];
  const failed: HerdrQueuedInput[] = [];
  const delivered: HerdrQueuedInput[] = [];
  for (const item of queue) {
    const receipt = byId.get(item.inputId);
    if (!receipt) {
      if (now - item.queuedAt > staleMs) failed.push(item);
      else keep.push(item);
      continue;
    }
    if (receipt.status === "queued") keep.push(item);
    else if (receipt.status === "delivered") delivered.push(item);
    else if (receipt.status === "failed") failed.push(item);
  }
  return { queue: keep, failed, delivered };
}

/**
 * 服务端回执是排队列表的真源：把该窗格仍在排队、带原文、本地列表里还没有的条目
 * 并进来（刷新 / 新标签页 / 另一个标签页发的），按入队时间排序。本地已有的条目原样保留。
 */
export function adoptServerQueue(
  queue: HerdrQueuedInput[],
  deliveries: HerdrInputDelivery[] | undefined,
  paneId: string | null,
): HerdrQueuedInput[] {
  if (!paneId || !deliveries?.length) return queue;
  const known = new Set(queue.map((item) => item.inputId));
  const adopted = deliveries
    .filter((d) => d.paneId === paneId && d.status === "queued" && typeof d.text === "string" && !known.has(d.inputId))
    .map((d) => ({ inputId: d.inputId, paneId: d.paneId, text: d.text!, queuedAt: d.queuedAt ?? 0 }));
  if (adopted.length === 0) return queue;
  return [...queue, ...adopted].sort((a, b) => a.queuedAt - b.queuedAt);
}

/** 失败 / 撤回的文本放回输入框：输入框空就直接放，否则另起一行接在后面（不覆盖新草稿）。 */
export function restoreDraft(current: string, restored: string): string {
  if (!current.trim()) return restored;
  if (current.includes(restored)) return current;
  return `${current.replace(/\s+$/, "")}\n${restored}`;
}
