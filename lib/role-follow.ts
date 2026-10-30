// 角色 P4「跟进我的会话」的共享契约（前后端都能 import）。设计见 docs/roles-p2.md C。
//
// 全局只能有一个角色开着跟进。服务端每 15 分钟扫一遍普通会话与 Herdr 窗格，挑出
// 「新进入」等你 / 卡住 / 失败 / 完成的对象，往这个角色的固定会话里插一条
// role-follow 系统节点（清单），绑了飞书 bot 的再用 bot 推一条。没变化不出声、不调模型。

export const FOLLOW_STATES = ["waiting", "stuck", "failed", "done"] as const;
export type FollowState = (typeof FOLLOW_STATES)[number];

export const FOLLOW_STATE_LABEL: Record<FollowState, string> = {
  waiting: "等你",
  stuck: "卡住",
  failed: "失败",
  done: "完成",
};

/** 「卡住」= 运行超过这么多分钟没有新输出。 */
export const ROLE_FOLLOW_DEFAULT_STALE_MIN = 20;
export const ROLE_FOLLOW_STALE_MIN_RANGE = [5, 240] as const;
/** 两次完整扫描之间的间隔。 */
export const ROLE_FOLLOW_INTERVAL_MS = 15 * 60_000;

/** 清单里的一项。subject 是去重键（`s:<会话 id>` / `h:<窗格键>`）。 */
export type RoleFollowItem = {
  subject: string;
  source: "session" | "herdr";
  state: FollowState;
  /** 点了打开的会话；没有就只展示 */
  sessionId: string | null;
  title: string;
  /** 一句补充：提问摘要 / 错误原文 / 已经多久没输出 */
  detail: string | null;
};

/** role-follow 系统节点的 meta（kind 之外的字段）。 */
export type RoleFollowMeta = { items: RoleFollowItem[]; scannedAt: number };

/** GET / PUT /api/roles/[id]/follow 的返回。 */
export type RoleFollowStatus = {
  /** 这个角色是否开着跟进 */
  enabled: boolean;
  /** 全局开着跟进的角色（可能是别的角色）；没人开 = null */
  activeRoleId: string | null;
  activeRoleName: string | null;
  staleMinutes: number;
  /** 上一次完整扫描的时间（进程内，重启清零） */
  lastScanAt: number | null;
};

/** PUT body。enabled=true 会关掉其它角色的跟进。 */
export type RoleFollowInput = { enabled: boolean; staleMinutes?: number };

export function followSessionHref(sessionId: string): string {
  return `/?session=${encodeURIComponent(sessionId)}`;
}

function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 节点标题：「跟进：2 个等你、1 个失败」。 */
export function followTitle(items: readonly Pick<RoleFollowItem, "state">[]): string {
  const parts = FOLLOW_STATES.map((st) => {
    const n = items.filter((i) => i.state === st).length;
    return n ? `${n} 个${FOLLOW_STATE_LABEL[st]}` : null;
  }).filter(Boolean);
  return `跟进：${parts.join("、")}`;
}

/** 节点正文 / 飞书消息：markdown 清单，每项链接到会话。base 给了就拼绝对链接（飞书用）。 */
export function followChecklistMarkdown(items: readonly RoleFollowItem[], base?: string | null): string {
  const root = base ? base.replace(/\/+$/, "") : "";
  return items
    .map((i) => {
      const title = oneLine(i.title || "未命名会话", 60).replace(/[[\]]/g, "");
      const link = i.sessionId ? `[${title}](${root}${followSessionHref(i.sessionId)})` : title;
      const detail = i.detail ? ` — ${oneLine(i.detail, 100)}` : "";
      return `- [ ] **${FOLLOW_STATE_LABEL[i.state]}** ${link}${detail}`;
    })
    .join("\n");
}

export function clampStaleMinutes(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : ROLE_FOLLOW_DEFAULT_STALE_MIN;
  return Math.min(ROLE_FOLLOW_STALE_MIN_RANGE[1], Math.max(ROLE_FOLLOW_STALE_MIN_RANGE[0], n));
}

// ── 搜索 / @ 引用里的角色标记（docs/roles-p2.md C「搜索 / @ 引用」）────────────────
// 全局搜索与 @ 候选纳入 kind='role'（角色固定会话）与 kind='group'（群聊，包 B）后，
// 结果行要带上角色头像 / 名字，不然一排「未命名会话」分不清是谁。

/** 结果里画头像要的最小角色信息。 */
export type RoleBadge = { id: string; name: string; avatarHue: number; avatarGlyph: string };

/** 会话来源标记：角色会话带 role，群聊 kind='group'（成员头像由包 B 自己画）。 */
export type SessionRoleTag = { sessionKind: string; role: RoleBadge | null };
