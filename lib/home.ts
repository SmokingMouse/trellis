// 首页（工作台总览）的纯数据层：问候语、会话归属标签、自动化任务的「下一次」与「最近异常」。
// 无 IO、无 React —— 单测直接喂数据。渲染在 components/HomeView.tsx。

import { nextFireAfter, parseCron } from "@/lib/cron";
import type { ProjectSummary, Session } from "@/lib/types";

/** 按本地时段的一句问候。 */
export function greetingFor(date: Date): string {
  const h = date.getHours();
  if (h < 5) return "夜深了";
  if (h < 11) return "早上好";
  if (h < 13) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

/** workspaceId → 「项目 / 工作区」标签；工作区与项目同名时只留项目名。 */
export function workspaceLabels(projects: ProjectSummary[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of projects) {
    for (const w of p.workspaces) {
      out.set(w.id, w.name && w.name !== p.name ? `${p.name} / ${w.name}` : p.name);
    }
  }
  return out;
}

/** 会话行上的归属：chat → 「对话」；project → 工作区标签，缺了就用路径末段。 */
export function sessionPlace(session: Pick<Session, "mode" | "workspaceId" | "workspacePath">, labels: Map<string, string>): string {
  if (session.workspaceId && labels.has(session.workspaceId)) return labels.get(session.workspaceId)!;
  if (session.workspacePath) {
    const parts = session.workspacePath.replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || session.workspacePath;
  }
  return "对话";
}

/** 最近用过的工作区（按 lastUsedAt），给「在某工作区开 Project 会话」下拉用。 */
export function recentWorkspaces(projects: ProjectSummary[], labels: Map<string, string>, limit = 6): { id: string; path: string; label: string }[] {
  return projects
    .flatMap((p) => p.workspaces)
    .filter((w) => w.path)
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || b.sessionCount - a.sessionCount)
    .slice(0, limit)
    .map((w) => ({ id: w.id, path: w.path, label: labels.get(w.id) ?? w.name }));
}

// ── 自动化任务 ──────────────────────────────────────────────────────────────

export type HomeTaskRun = {
  id: string;
  status: string;
  errorMessage: string | null;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  sessionId: string | null;
  nodeId: string | null;
};

export type HomeTask = {
  id: string;
  name: string;
  enabled: boolean;
  triggers: { kind: string; enabled: boolean; config: Record<string, unknown> }[];
  lastRun: HomeTaskRun | null;
};

/** 'interrupted' 是服务重启收尸留下的，不是任务失败 —— 首页与任务页一样渲染成灰色。 */
export function isInterruptedRun(r: Pick<HomeTaskRun, "status" | "errorMessage">): boolean {
  return r.status === "error" && r.errorMessage === "interrupted";
}

/** 真失败（红）：error（非 interrupted）/ timeout。 */
export function isFailedRun(r: Pick<HomeTaskRun, "status" | "errorMessage">): boolean {
  return (r.status === "error" && !isInterruptedRun(r)) || r.status === "timeout";
}

export function nextFireOf(task: HomeTask, from: Date): number | null {
  if (!task.enabled) return null;
  let best: number | null = null;
  for (const t of task.triggers) {
    if (!t.enabled || t.kind !== "cron") continue;
    const f = parseCron(String(t.config.expr ?? ""));
    const at = f ? nextFireAfter(f, from) : null;
    if (at !== null && (best === null || at < best)) best = at;
  }
  return best;
}

/** 下一次将运行的任务，按时间升序取前 limit 个（停用 / 仅手动的不算）。 */
export function upcomingTasks(tasks: HomeTask[], from: Date, limit = 3): { task: HomeTask; at: number }[] {
  return tasks
    .map((task) => ({ task, at: nextFireOf(task, from) }))
    .filter((x): x is { task: HomeTask; at: number } => x.at !== null)
    .sort((a, b) => a.at - b.at)
    .slice(0, limit);
}

/**
 * 最近一次没跑完的运行：真失败，或 interrupted（显示为灰）。
 * 只看每个任务的 lastRun —— 之后又成功过的就不算「最近异常」。
 */
export function latestProblemRun(tasks: HomeTask[]): { task: HomeTask; run: HomeTaskRun } | null {
  let best: { task: HomeTask; run: HomeTaskRun } | null = null;
  const at = (r: HomeTaskRun) => r.endedAt ?? r.startedAt ?? r.createdAt;
  for (const task of tasks) {
    const run = task.lastRun;
    if (!run || !(isFailedRun(run) || isInterruptedRun(run))) continue;
    if (!best || at(run) > at(best.run)) best = { task, run };
  }
  return best;
}

export function runProblemText(r: HomeTaskRun): string {
  if (isInterruptedRun(r)) return "中断（服务重启）";
  return r.status === "timeout" ? "超时" : "失败";
}

/** 「今天 09:00」「明天 09:00」「10/3 09:00」。 */
export function formatWhen(ts: number, now: Date): string {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((day(d) - day(now)) / 86_400_000);
  if (diffDays === 0) return `今天 ${hm}`;
  if (diffDays === 1) return `明天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
