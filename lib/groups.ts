// 群聊（角色 P2 · 包 B，docs/roles-p2.md）的共享契约：前后端都能 import 的类型、常量与纯函数。
//
// 群 = sessions.kind='group' 的一行 + group_members（成员角色）+ group_settings（策略与上限）。
// 群里每条消息都是一个节点：
//   · 用户消息：question = 原文，response = ''，meta.kind = 'group-user'
//   · 角色发言：question = ''，response = 发言，agent_id = 角色，meta.kind = 'group-reply'
//   · 一轮到顶：appendSystemNode(kind:'group-round-end')，前端渲染成上限卡
// 节点按时间串成一条线（每条接在上一条真实消息后面），群聊视图强制线性。
// 交互原型：docs/ui-redesign/mockups/09-roles.html 的 s-group / s-group-limit。

export type GroupReplyPolicy = "route" | "all" | "mention-only";

export const GROUP_POLICIES: readonly GroupReplyPolicy[] = ["route", "all", "mention-only"];

/** 群设置弹层里的文案（原型 [data-pop="group-set"]）。 */
export const GROUP_POLICY_LABEL: Record<GroupReplyPolicy, { title: string; desc: string }> = {
  route: { title: "挑最合适的一位回", desc: "由路由按话题挑人，其他人不说话" },
  all: { title: "谁有话谁说", desc: "每位都看一遍，自己决定接不接话" },
  "mention-only": { title: "只有被 @ 的回", desc: "不 @ 就没人回" },
};

export const GROUP_MIN_MEMBERS = 2;
export const GROUP_MAX_MEMBERS = 6;
export const GROUP_DEFAULT_MAX_PASSES = 3;
export const GROUP_DEFAULT_MAX_MESSAGES = 10;
export const GROUP_PASSES_RANGE = [1, 6] as const;
export const GROUP_MESSAGES_RANGE = [1, 30] as const;

/** @所有人：每位成员都回。 */
export const GROUP_ALL_MENTION = "所有人";
/** 「谁有话谁说」策略下没话说的成员回这一句，界面不显示。 */
export const GROUP_SKIP_TOKEN = "（跳过）";
/** 增量里用户自己的署名。 */
export const GROUP_USER_LABEL = "用户";

export type GroupSettings = {
  replyPolicy: GroupReplyPolicy;
  maxPasses: number;
  maxMessages: number;
};

export type GroupMember = {
  roleId: string;
  name: string;
  intro: string;
  avatarHue: number;
  avatarGlyph: string;
  sortOrder: number;
};

export type GroupRoundStatus = "routing" | "running" | "done" | "stopped" | "limit";

/** 一轮 = 一条用户消息（或「继续讨论」）引出的所有发言。只存在于服务端内存。 */
export type GroupRound = {
  id: string;
  status: GroupRoundStatus;
  /** 当前第几遍（从 1 起） */
  pass: number;
  maxPasses: number;
  /** 这一轮已经出现的发言条数（跳过 / 出错的不算） */
  messages: number;
  maxMessages: number;
  /** 正在说的那位；routing 时为 null */
  current: { roleId: string; nodeId: string | null } | null;
  /** 排在后面、这一遍还没轮到的成员 */
  queued: string[];
  startedAt: number;
  endedAt: number | null;
};

/** GET /api/groups 列表项、GET /api/groups/[id] 的形状。id 就是会话 id。 */
export type Group = {
  id: string;
  name: string;
  /** 群的工作目录；null = 每位成员在自己的工作目录里跑 */
  workDir: string | null;
  members: GroupMember[];
  settings: GroupSettings;
  /** 建群时锁定的模型（ProviderId）；null = 默认 */
  model: string | null;
  createdAt: number;
  /** 最近一条消息的时间（没消息 = 建群时间） */
  lastActiveAt: number;
  /** 最近一条可见消息的作者与开头（手机首页副标题用） */
  lastMessage: { name: string; text: string } | null;
  round: GroupRound | null;
};

/** POST /api/groups */
export type GroupInput = {
  name: string;
  roleIds: string[];
  workDir?: string | null;
  provider?: string;
};

/** PATCH /api/groups/[id] */
export type GroupPatch = {
  name?: string;
  workDir?: string | null;
  settings?: Partial<GroupSettings>;
  addRoleIds?: string[];
  removeRoleIds?: string[];
};

export type GroupReplyTo = { nodeId: string; name: string; excerpt: string };

/** nodes.meta_json 里群聊相关的三种形状。 */
export type GroupNodeMeta =
  | { kind: "group-user" }
  | {
      kind: "group-reply";
      roleId: string;
      pass: number;
      roundId: string;
      replyTo?: GroupReplyTo | null;
      /** 「谁有话谁说」时回了（跳过）：界面不显示、不进别人的增量 */
      skipped?: boolean;
    }
  | {
      kind: "group-round-end";
      roundId: string;
      reason: "passes" | "messages";
      passes: number;
      messages: number;
      /** 到顶时还排着、没轮到的成员；「继续讨论」从它们接着说 */
      pending: { roleId: string; triggerNodeId: string | null }[];
    };

/** GET /api/groups/[id]/events 的 SSE 事件。 */
export type GroupEvent =
  | { type: "round"; round: GroupRound | null }
  | { type: "node"; node: unknown };

export function groupNodeMeta(meta: Record<string, unknown> | null | undefined): GroupNodeMeta | null {
  const k = meta?.kind;
  if (k === "group-user" || k === "group-reply" || k === "group-round-end") return meta as GroupNodeMeta;
  return null;
}

// ---------------------------------------------------------------- @ 解析

export type MentionResult = {
  /** 按出现顺序、去重后的成员 roleId */
  roleIds: string[];
  /** 出现了 @所有人 */
  all: boolean;
};

const ASCII_WORD = /[A-Za-z0-9_]/;

/**
 * 解析一段话里 @ 了谁：`@名字` 按成员名最长优先匹配（「@老周」不会被「@老」截走）；
 * 以 ASCII 字母数字结尾的名字要求后面不是字母数字（「@Iris」不匹配「@Irish」），中文名不设边界
 * （「@老周你看」照样认）。`@所有人` / `@all` = 所有人。大小写不敏感。
 */
export function parseMentions(
  text: string,
  members: Pick<GroupMember, "roleId" | "name">[],
): MentionResult {
  const byLen = [...members]
    .filter((m) => m.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const out: string[] = [];
  let all = false;
  const lower = text.toLowerCase();
  for (let i = lower.indexOf("@"); i !== -1; i = lower.indexOf("@", i + 1)) {
    const rest = lower.slice(i + 1);
    if (rest.startsWith(GROUP_ALL_MENTION) || (rest.startsWith("all") && !ASCII_WORD.test(rest[3] ?? ""))) {
      all = true;
      continue;
    }
    for (const m of byLen) {
      const name = m.name.trim().toLowerCase();
      if (!rest.startsWith(name)) continue;
      const last = name[name.length - 1];
      if (ASCII_WORD.test(last) && ASCII_WORD.test(rest[name.length] ?? "")) continue;
      if (!out.includes(m.roleId)) out.push(m.roleId);
      break;
    }
  }
  return { roleIds: out, all };
}

// ---------------------------------------------------------------- 挑人

export type ResponderPlan =
  | { mode: "mention"; roleIds: string[] }
  | { mode: "all"; roleIds: string[]; optional: boolean }
  | { mode: "route" }
  | { mode: "none" };

/**
 * 用户发了一条消息，这一遍谁来回：
 *   有 @ → 只让被 @ 的依次回（@所有人 = 全体，按成员顺序，必须回）；
 *   没 @ → 按群策略：route = 交给路由挑一位、all = 每位依次看、可以回（跳过）、mention-only = 没人回。
 */
export function planUserResponders(
  text: string,
  members: Pick<GroupMember, "roleId" | "name">[],
  policy: GroupReplyPolicy,
): ResponderPlan {
  const m = parseMentions(text, members);
  if (m.all) return { mode: "all", roleIds: members.map((x) => x.roleId), optional: false };
  if (m.roleIds.length > 0) return { mode: "mention", roleIds: m.roleIds };
  if (policy === "all") return { mode: "all", roleIds: members.map((x) => x.roleId), optional: true };
  if (policy === "route") return { mode: "route" };
  return { mode: "none" };
}

/** 一位成员的发言里 @ 了谁（下一遍的人）：去掉自己；@所有人 = 除自己外全体。 */
export function replyHandoffs(
  text: string,
  members: Pick<GroupMember, "roleId" | "name">[],
  selfRoleId: string,
): string[] {
  const m = parseMentions(text, members);
  const ids = m.all ? members.map((x) => x.roleId) : m.roleIds;
  return ids.filter((id) => id !== selfRoleId);
}

/** 路由不调模型的快路径：消息里直接叫了某位的名字（没加 @）就是他。 */
export function routeByName(
  text: string,
  members: Pick<GroupMember, "roleId" | "name">[],
): string | null {
  const lower = text.toLowerCase();
  let best: { id: string; at: number } | null = null;
  for (const m of members) {
    const name = m.name.trim().toLowerCase();
    if (!name) continue;
    const at = lower.indexOf(name);
    if (at === -1) continue;
    if (ASCII_WORD.test(name[name.length - 1]) && ASCII_WORD.test(lower[at + name.length] ?? "")) continue;
    if (!best || at < best.at) best = { id: m.roleId, at };
  }
  return best?.id ?? null;
}

/** 从路由模型的输出里认出成员：输出里最早出现的那个名字。 */
export function pickRoutedMember(
  output: string,
  members: Pick<GroupMember, "roleId" | "name">[],
): string | null {
  return routeByName(output.replace(/^@/, ""), members);
}

// ---------------------------------------------------------------- 增量

export type GroupTranscriptItem = {
  /** nodes.rowid：单调递增，成员的 last_seen_seq 和它比 */
  seq: number;
  /** null = 用户 */
  roleId: string | null;
  name: string;
  text: string;
};

const DELTA_ITEM_MAX = 4000;

/**
 * 一位成员没看过的群消息，格式「[名字]：内容」，一条一段。
 * 只取 seq > lastSeen、不是它自己说的；最多 maxItems 条（新加入 / CLI 会话丢了时只给最近的）。
 */
export function formatUnseenDelta(
  items: GroupTranscriptItem[],
  opts: { selfRoleId: string; lastSeenSeq: number; maxItems?: number },
): { text: string; count: number; maxSeq: number } {
  const unseen = items
    .filter((it) => it.seq > opts.lastSeenSeq && it.roleId !== opts.selfRoleId && it.text.trim())
    .sort((a, b) => a.seq - b.seq);
  const picked = opts.maxItems ? unseen.slice(-opts.maxItems) : unseen;
  const text = picked
    .map((it) => {
      const body = it.text.trim();
      const clipped = body.length > DELTA_ITEM_MAX ? `${body.slice(0, DELTA_ITEM_MAX)}…（已截断）` : body;
      return `[${it.name}]：${clipped}`;
    })
    .join("\n\n");
  const maxSeq = items.reduce((m, it) => Math.max(m, it.seq), opts.lastSeenSeq);
  return { text, count: picked.length, maxSeq };
}

/** 这条发言是不是「（跳过）」：去掉空白和标点后只剩「跳过」。流式中途用 prefix=true 判断「可能是」。 */
export function isSkipReply(text: string, prefix = false): boolean {
  const t = text.replace(/[\s（）()【】[\]。.!！]/g, "");
  if (!t) return prefix;
  if (prefix) return "跳过".startsWith(t) || t === "跳过";
  return t === "跳过" || t.toLowerCase() === "skip" || t.toLowerCase() === "pass";
}

// ---------------------------------------------------------------- 轮次预算

/**
 * 一轮的刹车（原型「来回 3 遍 · 最多 10 条」）。纯状态机，编排器每说完一条就问它：
 *   canSpeak()：这一条还能不能开口（条数没到顶）；
 *   nextPass()：这一遍说完了，还有人被 @ 着，能不能进下一遍。
 */
export class GroupRoundBudget {
  pass = 1;
  messages = 0;
  constructor(
    readonly maxPasses: number,
    readonly maxMessages: number,
  ) {}
  canSpeak(): boolean {
    return this.messages < this.maxMessages;
  }
  spoke(): void {
    this.messages += 1;
  }
  canAdvance(): boolean {
    return this.pass < this.maxPasses;
  }
  advance(): void {
    this.pass += 1;
  }
}

export function clampSetting(v: unknown, range: readonly [number, number], fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(range[1], Math.max(range[0], Math.round(v)));
}

/** 「让管家记成任务」的预填草稿：把最近一轮的发言原文交给管家，结论由它归纳。 */
export function buildButlerTaskDraft(
  groupName: string,
  lines: { name: string; text: string }[],
): string {
  const body = lines
    .slice(-12)
    .map((l) => {
      const t = l.text.replace(/\s+/g, " ").trim();
      return `- [${l.name}] ${t.length > 240 ? `${t.slice(0, 240)}…` : t}`;
    })
    .join("\n");
  return [
    `把群聊「${groupName}」这一轮讨论的结论记成一个任务。先把你打算建的任务（名字、要做什么、什么时候跑）讲给我确认，再动手。`,
    "",
    "讨论原文：",
    body,
  ].join("\n");
}
