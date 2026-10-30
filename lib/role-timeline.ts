// 角色时间线的纯函数（components/LinearThreadView.tsx 角色分支 + RoleMemoryLine 用）。
// 角色只有一条对话：会话里所有根按时间串成一条线，根与根之间是「新话题」，跨天画日期分隔；
// 回复里写了角色记忆文件的，在回复下面画「记下了…」。

import { isRoleMemoryPath, memoryFileName } from "./roles";
import type { ChatNode } from "./types";

const DAY = 86_400_000;
const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 两个时间戳是不是同一个本地日历日。 */
export function sameLocalDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/** 日期分隔线的文案：今天 / 昨天 / 「10 月 28 日 周二」（不是今年的带上年份）。 */
export function dayDividerLabel(ts: number, now: number = Date.now()): string {
  const diff = Math.round((startOfDay(now) - startOfDay(ts)) / DAY);
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  const d = new Date(ts);
  const year = d.getFullYear() === new Date(now).getFullYear() ? "" : `${d.getFullYear()} 年 `;
  return `${year}${d.getMonth() + 1} 月 ${d.getDate()} 日 ${WEEKDAY[d.getDay()]}`;
}

/** 「新话题 · HH:MM」里的时刻。 */
export function clockLabel(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export type MemoryWriteTool = "Write" | "Edit" | "MultiEdit";

/** 一轮回复里对某个记忆文件的写入。tool = null：只知道写过（会话载荷里的 generatedFiles），
 * 还不知道是新建还是改动——完整 toolCalls 拉回来之前一律按「改动」对待（不给撤销）。 */
export type MemoryWrite = { path: string; file: string; tool: MemoryWriteTool | null };

const MEMORY_TOOLS = new Set<string>(["Write", "Edit", "MultiEdit"]);

/**
 * 这一轮写过的角色记忆文件，按首次出现排序、按文件去重。
 * 优先看完整 toolCalls（只认已完成的调用）；没有就退回会话载荷里预计算的 generatedFiles。
 * 同一文件这一轮先 Write 再 Edit 仍算新建（tool 取第一次）。
 */
export function memoryWritesOf(
  node: Pick<ChatNode, "toolCalls" | "generatedFiles">,
  homeDir: string,
): MemoryWrite[] {
  const out = new Map<string, MemoryWrite>();
  if (node.toolCalls.length > 0) {
    for (const tc of node.toolCalls) {
      if (!MEMORY_TOOLS.has(tc.name) || tc.status !== "done") continue;
      const input = tc.input as Record<string, unknown> | null;
      const fp = input && typeof input === "object" ? input.file_path : null;
      if (typeof fp !== "string" || !isRoleMemoryPath(homeDir, fp) || out.has(fp)) continue;
      out.set(fp, { path: fp, file: memoryFileName(fp), tool: tc.name as MemoryWriteTool });
    }
    return [...out.values()];
  }
  for (const f of node.generatedFiles ?? []) {
    if (!isRoleMemoryPath(homeDir, f.absPath) || out.has(f.absPath)) continue;
    out.set(f.absPath, { path: f.absPath, file: memoryFileName(f.absPath), tool: null });
  }
  return [...out.values()];
}
