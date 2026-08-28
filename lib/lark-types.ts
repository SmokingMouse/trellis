export type LarkChatType = "p2p" | "group";
export type LarkInboxStatus = "processing" | "done" | "error" | "ignored";

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
};

export type LarkBotInput = {
  name: string;
  appId: string;
  appSecret?: string;
  agentId?: string | null;
  workspacePath?: string | null;
  enabled?: boolean;
};
