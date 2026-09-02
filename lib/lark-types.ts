export type LarkChatType = "p2p" | "group";
export type LarkInboxStatus = "processing" | "done" | "error" | "ignored";

/**
 * S134 IM 入口层四旋钮（spec: progress/im-entry-layer.md）。取值是 IM 无关的策略，
 * 飞书只提供实现：将来 Telegram / 企微接进来复用同一组枚举。
 */
export type LarkGroupTrigger = "mention" | "all" | "prefix";
export type LarkSessionPolicy = "thread" | "chat";
export type LarkReplyMode = "thread" | "quote" | "plain";
export type LarkAckMode = "reaction" | "none";

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
};

export const LARK_GROUP_TRIGGERS: readonly LarkGroupTrigger[] = ["mention", "all", "prefix"];
export const LARK_SESSION_POLICIES: readonly LarkSessionPolicy[] = ["thread", "chat"];
export const LARK_REPLY_MODES: readonly LarkReplyMode[] = ["thread", "quote", "plain"];
export const LARK_ACK_MODES: readonly LarkAckMode[] = ["reaction", "none"];

/** 用户拍板的默认值（S134）：群仅 @ 触发、话题即树、话题回复、表情确认。 */
export const LARK_POLICY_DEFAULTS: LarkBotPolicy = {
  groupTrigger: "mention",
  triggerPrefix: null,
  sessionPolicy: "thread",
  replyMode: "thread",
  ackMode: "reaction",
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
