// 角色 P2 · 夜间整理的共享契约（docs/roles-p2.md 的 A 包）：前后端都能 import 的类型与纯函数。
//
// 夜间整理 = 每个角色一个内置例行：读自上次整理以来的新对话，起一次 headless claude，
// 让它**只输出 JSON 提案**（不碰文件），服务端解析成 role_changes 行，再往角色固定会话
// 里插一个 meta.kind='role-nightly' 的系统节点。时间线认出它画成整理卡，用户逐条接受 /
// 拒绝；接受才落成文件，7 天内可按 before_json 撤销。

// ---------------------------------------------------------------- 提案

export const ROLE_CHANGE_KINDS = ["add", "merge", "delete", "skill"] as const;
export type RoleChangeKind = (typeof ROLE_CHANGE_KINDS)[number];

export const ROLE_CHANGE_STATUSES = ["pending", "applied", "rejected", "reverted", "failed"] as const;
export type RoleChangeStatus = (typeof ROLE_CHANGE_STATUSES)[number];

/** 一条记忆的完整内容（与 memories/*.md 的 frontmatter 对应）。 */
export type ProposedMemory = {
  file: string;
  name: string;
  description: string;
  type: "user" | "feedback" | "project" | "reference";
  body: string;
};

/** role_changes.payload_json：按 kind 区分。reason = 给人看的一句理由（卡片副标题）。 */
export type RoleChangePayload =
  | { kind: "add"; memory: ProposedMemory; reason: string }
  | { kind: "merge"; files: string[]; into: ProposedMemory; reason: string }
  | { kind: "delete"; file: string; name: string; reason: string }
  | { kind: "skill"; name: string; description: string; body: string; reason: string };

/** GET /api/roles/[id]/changes 的列表项。 */
export type RoleChange = {
  id: string;
  roleId: string;
  /** 所在整理卡（系统节点）的 id */
  nodeId: string | null;
  kind: RoleChangeKind;
  payload: RoleChangePayload;
  status: RoleChangeStatus;
  error: string | null;
  createdAt: number;
  decidedAt: number | null;
  revertedAt: number | null;
  /** applied 且在撤销期内 */
  revertible: boolean;
};

/** 接受后可撤销的时长。 */
export const ROLE_CHANGE_REVERT_MS = 7 * 24 * 60 * 60 * 1000;

export function isRevertible(c: Pick<RoleChange, "status" | "decidedAt">, now = Date.now()): boolean {
  return c.status === "applied" && c.decidedAt !== null && now - c.decidedAt <= ROLE_CHANGE_REVERT_MS;
}

/** 卡片左侧的标签文案。 */
export const ROLE_CHANGE_LABEL: Record<RoleChangeKind, string> = {
  add: "新增",
  merge: "合并",
  delete: "删除",
  skill: "技能",
};

/** 卡片一行的标题。 */
export function roleChangeTitle(p: RoleChangePayload): string {
  switch (p.kind) {
    case "add":
      return p.memory.name;
    case "merge":
      return `${p.files.length} 条合成一条：${p.into.name}`;
    case "delete":
      return `「${p.name}」`;
    case "skill":
      return `存成技能「${p.name}」`;
  }
}

// ---------------------------------------------------------------- 频率与状态

export const NIGHTLY_FREQUENCIES = ["daily", "weekly", "off"] as const;
export type NightlyFrequency = (typeof NIGHTLY_FREQUENCIES)[number];

export const NIGHTLY_FREQUENCY_LABEL: Record<NightlyFrequency, string> = {
  daily: "每天 03:30",
  weekly: "每周一 03:30",
  off: "关闭",
};

/** 整理时刻（本地时间）。每周档在周一。 */
export const NIGHTLY_HOUR = 3;
export const NIGHTLY_MINUTE = 30;

/** GET /api/roles/[id]/nightly */
export type RoleNightlyState = {
  frequency: NightlyFrequency;
  /** 上一次整理处理到的节点时间戳（ms）；之后的节点算「新对话」 */
  cursorAt: number | null;
  lastRunAt: number | null;
  /** ran = 出了提案；empty = 跑了但没提案；skipped = 没新对话；error = 失败 */
  lastStatus: "ran" | "empty" | "skipped" | "error" | null;
  lastError: string | null;
  running: boolean;
  /** 自 cursorAt 以来的新节点数（给「立即整理」按钮判断要不要点） */
  pendingNodes: number;
};

export function isNightlyFrequency(v: unknown): v is NightlyFrequency {
  return typeof v === "string" && (NIGHTLY_FREQUENCIES as readonly string[]).includes(v);
}

/** 某频率下 ≤ now 的最近一个计划槽（ms，本地时间）。off → null。纯函数，调度与测试共用。 */
export function latestNightlySlot(freq: NightlyFrequency, now: Date): number | null {
  if (freq === "off") return null;
  const d = new Date(now.getTime());
  d.setHours(NIGHTLY_HOUR, NIGHTLY_MINUTE, 0, 0);
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 1);
  if (freq === "weekly") {
    // 退到最近的周一（getDay：0=周日，1=周一）
    while (d.getDay() !== 1) d.setDate(d.getDate() - 1);
  }
  return d.getTime();
}
