export type LarkChatType = "p2p" | "group";
export type LarkInboxStatus = "processing" | "done" | "error" | "ignored" | "pending";

/**
 * S134 IM 入口层四旋钮（spec: progress/im-entry-layer.md）+ 访问控制模式。
 * 取值是 IM 无关的策略，飞书只提供实现。
 */
export type LarkGroupTrigger = "mention" | "all" | "prefix";
export type LarkSessionPolicy = "thread" | "chat";
export type LarkReplyMode = "thread" | "quote" | "plain";
export type LarkAckMode = "reaction" | "none";
export type LarkAccessMode = "open" | "approval";

export type LarkBotMemberRole = "admin" | "member";
export type LarkBotMemberStatus = "pending" | "approved" | "denied";

export const LARK_MEMBER_ROLES: readonly LarkBotMemberRole[] = ["admin", "member"];
export const LARK_MEMBER_STATUSES: readonly LarkBotMemberStatus[] = ["pending", "approved", "denied"];

export type LarkBotMember = {
  id: string;
  botId: string;
  openId: string;
  role: LarkBotMemberRole;
  status: LarkBotMemberStatus;
  code: string;
  name: string | null;
  pendingPreview: string | null;
  pendingChatId: string | null;
  appliedAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  createdAt: number;
  updatedAt: number;
};

export type LarkBotPolicy = {
  /** 群里什么消息算对机器人说的。私聊固定全收。 */
  groupTrigger: LarkGroupTrigger;
  /** groupTrigger=prefix 时的前缀，如 "/ask"。 */
  triggerPrefix: string | null;
  /** thread：群里每个话题一棵树；chat：一个 chat 一条线性链。私聊恒线性。 */
  sessionPolicy: LarkSessionPolicy;
  /** 群里回复形式。私聊恒引用回复。 */
  replyMode: LarkReplyMode;
  /** 收到即回 OnIt 表情。 */
  ackMode: LarkAckMode;
  /** 对话权限模式：open 开放（默认）；approval 需管理员审批。 */
  accessMode: LarkAccessMode;
};

export const LARK_GROUP_TRIGGERS: readonly LarkGroupTrigger[] = ["mention", "all", "prefix"];
export const LARK_SESSION_POLICIES: readonly LarkSessionPolicy[] = ["thread", "chat"];
export const LARK_REPLY_MODES: readonly LarkReplyMode[] = ["thread", "quote", "plain"];
export const LARK_ACK_MODES: readonly LarkAckMode[] = ["reaction", "none"];
export const LARK_ACCESS_MODES: readonly LarkAccessMode[] = ["open", "approval"];

/** 用户拍板的默认值（S134）：群仅 @ 触发、话题即树、话题回复、表情确认、开放模式。 */
export const LARK_POLICY_DEFAULTS: LarkBotPolicy = {
  groupTrigger: "mention",
  triggerPrefix: null,
  sessionPolicy: "thread",
  replyMode: "thread",
  ackMode: "reaction",
  accessMode: "open",
};

export type LarkChat = {
  id: string;
  botId: string;
  chatId: string;
  chatType: LarkChatType;
  sessionId: string | null;
  lastNodeId: string | null;
  title: string | null;
  lastMessageAt: number | null;
  createdAt: number;
};

/** API/UI 可见输出形状。已保存的 appSecret 永不出现在任何读取响应里。 */
export type LarkBot = {
  id: string;
  name: string;
  appId: string;
  hasSecret: boolean;
  agentId: string | null;
  workspacePath: string | null;
  enabled: boolean;
  botOpenId: string | null;
  botName: string | null;
  lastConnectedAt: number | null;
  lastError: string | null;
  /** 最近一次飞书 API 报缺的应用身份 scope（99991672）；扫码更新成功后清空。 */
  missingScopes?: string[];
  createdAt: number;
  updatedAt: number;
  chats: LarkChat[];
} & LarkBotPolicy;

export type LarkBotInput = {
  name: string;
  appId: string;
  appSecret?: string;
  agentId?: string | null;
  workspacePath?: string | null;
  enabled?: boolean;
} & Partial<LarkBotPolicy>;

// ── 扫码建 / 更新 bot（飞书官方 registerApp 流程）的 API 契约：server 与设置页共用 ──

/** POST /api/lark-bots/register 请求体。 */
export type LarkRegisterRequest =
  | {
      mode: "create";
      /** 预填到飞书创建页的应用名，同时作为 trellis 里的 bot 名。 */
      name: string;
      description?: string;
      agentId?: string | null;
      workspacePath?: string | null;
      /** 缺省 approval：别人和 bot 聊天前要创建者批准。 */
      accessMode?: LarkAccessMode;
    }
  | {
      mode: "update";
      botId: string;
      /** 额外要补的应用身份 scope；服务端会并上 trellis 标准集和该 bot 记录的 missingScopes。 */
      scopes?: string[];
    };

/** POST /api/lark-bots/register 响应：url 即二维码内容（飞书确认页）。 */
export type LarkRegisterStart = { sessionId: string; url: string; expiresAt: number };

/**
 * waiting 等用户在飞书确认 → binding 已拿到凭证、正在写库 / 连接 → done；
 * 终态另有 denied（确认页取消）/ expired（二维码过期）/ cancelled（DELETE 取消）/ error。
 */
export type LarkRegisterStatus = "waiting" | "binding" | "done" | "denied" | "expired" | "cancelled" | "error";

/** GET /api/lark-bots/register/:sessionId 响应；DELETE 同一路径 = 取消。永不含 secret。 */
export type LarkRegisterSession = {
  sessionId: string;
  mode: "create" | "update";
  status: LarkRegisterStatus;
  url: string;
  expiresAt: number;
  botId: string | null;
  appId: string | null;
  /** create：长连接已连上；update：更新后已按新配置重连。 */
  connected: boolean;
  /** create：创建者已登记为该 bot 的管理员。 */
  adminBound: boolean;
  /** create：已用新 bot 给创建者发了欢迎私聊（闭环验证）。 */
  welcomeSent: boolean;
  error: string | null;
};
