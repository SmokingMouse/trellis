// 角色 P2 · 例行 / 渠道 / 能力 / 后台任务的共享契约（docs/roles-p2.md 的 A 包）。
//
// 例行 = tasks 表里 agent_id = 角色的任务 + 一条 cron 触发器；跑出来的结果落进角色的
// 固定会话（不另开 task home 会话）。夜间整理是每个角色自带的内置例行，不占 tasks 行。

export const ROUTINE_TRIGGER_KINDS = ["daily", "weekdays", "weekly", "cron"] as const;
export type RoutineTriggerKind = (typeof ROUTINE_TRIGGER_KINDS)[number];

/** 新建例行时选的触发方式。time = "HH:MM"（本地时间），day = 0–6（0 = 周日）。 */
export type RoutineTrigger =
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; day: number; time: string }
  | { kind: "cron"; expr: string };

export const WEEKDAY_LABEL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function parseTime(t: string): { h: number; m: number } | null {
  const m = TIME_RE.exec(t.trim());
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null;
}

/** 触发方式 → cron 表达式。非法 → null（cron 合法性由服务端再用 parseCron 校验）。 */
export function routineCron(t: RoutineTrigger): string | null {
  if (t.kind === "cron") return t.expr.trim() || null;
  const tm = parseTime(t.time);
  if (!tm) return null;
  if (t.kind === "daily") return `${tm.m} ${tm.h} * * *`;
  if (t.kind === "weekdays") return `${tm.m} ${tm.h} * * 1-5`;
  if (!Number.isInteger(t.day) || t.day < 0 || t.day > 6) return null;
  return `${tm.m} ${tm.h} * * ${t.day}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** cron → 人话（只认本页能建出来的三种形状，其余原样给出）。 */
export function describeRoutineCron(expr: string): string {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(expr.trim());
  if (!m) return `cron ${expr}`;
  const time = `${pad(Number(m[2]))}:${pad(Number(m[1]))}`;
  if (m[3] === "*") return `每天 ${time}`;
  if (m[3] === "1-5") return `工作日 ${time}`;
  return `每${WEEKDAY_LABEL[Number(m[3])]} ${time}`;
}

/** GET /api/roles/[id]/routines 的列表项（tasks 行 + 第一条 cron 触发器 + 最近一次结果）。 */
export type RoleRoutine = {
  taskId: string;
  name: string;
  prompt: string;
  enabled: boolean;
  /** 第一条 cron 触发器的表达式；没有 = null（只能手动跑） */
  cron: string | null;
  /** 没发现就不出声：回答恰为 [SILENT] 时这一轮在时间线里收起 */
  quiet: boolean;
  lastRun: { status: string; at: number } | null;
  createdAt: number;
};

/** POST /api/roles/[id]/routines 的 body。 */
export type RoleRoutineInput = {
  name: string;
  prompt: string;
  trigger: RoutineTrigger;
  quiet?: boolean;
  enabled?: boolean;
};

/** 静默约定（与飞书任务推送同一个标记）。 */
export const ROUTINE_SILENT_MARK = "[SILENT]";

/** 「没发现就不出声」时追加在例行 prompt 后面的说明。 */
export const ROUTINE_QUIET_SUFFIX =
  `\n\n（如果这次没有发现任何值得告诉用户的东西，整条回答只写 ${ROUTINE_SILENT_MARK}，不要写别的。）`;

export function isRoutineSilent(text: string): boolean {
  return text.trim().replace(/^`+|`+$/g, "").trim() === ROUTINE_SILENT_MARK;
}

// ---------------------------------------------------------------- 后台任务

/** 角色在对话里开的后台任务：它用 trellisctl ask --new 起的一条普通会话。 */
export type RoleBackgroundTask = {
  sessionId: string;
  /** 后台会话的第一轮 */
  nodeId: string;
  /** 在角色时间线里是哪一轮开的 */
  originNodeId: string;
  title: string;
  status: "streaming" | "done" | "error";
  /** 后台会话的轮数 */
  turns: number;
  durationMs: number | null;
  createdAt: number;
  updatedAt: number;
};

// ---------------------------------------------------------------- 能力

/** GET /api/roles/[id]/capabilities */
export type RoleCapabilities = {
  /** null = 不限制 */
  tools: string[] | null;
  disallowedTools: string[] | null;
  /** 挂载的本机技能（~/.claude/skills/<dir>） */
  hostSkills: string[];
  /** 角色自己的技能（<roleDir>/skills/<name>/SKILL.md，夜间整理提的或手写的） */
  roleSkills: { name: string; description: string; updatedAt: number }[];
};

/** PUT /api/roles/[id]/capabilities 的 body（都可选）。 */
export type RoleCapabilitiesInput = {
  tools?: string[] | null;
  disallowedTools?: string[] | null;
  hostSkills?: string[];
};

/** 角色技能目录名：小写字母、数字、连字符。 */
export const ROLE_SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
