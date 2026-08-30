import "server-only";
import type { LarkBot, LarkBotInput, LarkChat, LarkChatType, LarkInboxStatus } from "@/lib/lark-types";
import { getDB } from "@/lib/server/sqlite";
import { claimLarkInboxIn } from "./protocol";

export type LarkBotRecord = Omit<LarkBot, "hasSecret" | "chats"> & {
  appSecret: string;
};

type BotRow = {
  id: string;
  name: string;
  app_id: string;
  app_secret: string;
  agent_id: string | null;
  workspace_path: string | null;
  enabled: number;
  bot_open_id: string | null;
  bot_name: string | null;
  last_connected_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

type ChatRow = {
  id: string;
  bot_id: string;
  chat_id: string;
  chat_type: string;
  session_id: string | null;
  last_node_id: string | null;
  title: string | null;
  last_message_at: number | null;
  created_at: number;
};

const BOT_COLUMNS = `id, name, app_id, app_secret, agent_id, workspace_path, enabled,
  bot_open_id, bot_name, last_connected_at, last_error, created_at, updated_at`;

function rowToBot(row: BotRow): LarkBotRecord {
  return {
    id: row.id,
    name: row.name,
    appId: row.app_id,
    appSecret: row.app_secret,
    agentId: row.agent_id,
    workspacePath: row.workspace_path,
    enabled: row.enabled === 1,
    botOpenId: row.bot_open_id,
    botName: row.bot_name,
    lastConnectedAt: row.last_connected_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToChat(row: ChatRow): LarkChat {
  return {
    id: row.id,
    botId: row.bot_id,
    chatId: row.chat_id,
    chatType: row.chat_type === "group" ? "group" : "p2p",
    sessionId: row.session_id,
    lastNodeId: row.last_node_id,
    title: row.title,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
  };
}

function publicBot(record: LarkBotRecord): LarkBot {
  const { appSecret: _secret, ...rest } = record;
  return { ...rest, hasSecret: _secret.length > 0, chats: listLarkChats(record.id) };
}

function requiredText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} 不能为空`);
  return trimmed;
}

export function listLarkBotRecords(enabledOnly = false): LarkBotRecord[] {
  const where = enabledOnly ? " WHERE enabled = 1" : "";
  return (
    getDB().query(`SELECT ${BOT_COLUMNS} FROM lark_bots${where} ORDER BY created_at DESC`).all() as BotRow[]
  ).map(rowToBot);
}

export function listLarkBots(): LarkBot[] {
  return listLarkBotRecords().map(publicBot);
}

export function getLarkBotRecord(id: string): LarkBotRecord | null {
  const row = getDB().query(`SELECT ${BOT_COLUMNS} FROM lark_bots WHERE id = ?`).get(id) as
    | BotRow
    | undefined;
  return row ? rowToBot(row) : null;
}

export function getLarkBotRecordByAppId(appId: string): LarkBotRecord | null {
  const row = getDB().query(`SELECT ${BOT_COLUMNS} FROM lark_bots WHERE app_id = ?`).get(appId) as
    | BotRow
    | undefined;
  return row ? rowToBot(row) : null;
}

export function getLarkBot(id: string): LarkBot | null {
  const record = getLarkBotRecord(id);
  return record ? publicBot(record) : null;
}

export function getLarkBotByAppId(appId: string): LarkBot | null {
  const record = getLarkBotRecordByAppId(appId);
  return record ? publicBot(record) : null;
}

export function createLarkBot(input: LarkBotInput): LarkBot {
  const name = requiredText(input.name, "名称");
  const appId = requiredText(input.appId, "app_id");
  const appSecret = requiredText(input.appSecret ?? "", "app_secret");
  const id = crypto.randomUUID();
  const now = Date.now();
  getDB().prepare(
    `INSERT INTO lark_bots
      (id, name, app_id, app_secret, agent_id, workspace_path, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    appId,
    appSecret,
    input.agentId?.trim() || null,
    input.workspacePath?.trim() || null,
    input.enabled === false ? 0 : 1,
    now,
    now,
  );
  return getLarkBot(id)!;
}

export function updateLarkBot(id: string, patch: Partial<LarkBotInput>): LarkBot | null {
  if (!getLarkBotRecord(id)) return null;
  const sets: string[] = [];
  const values: unknown[] = [];
  const put = (column: string, value: unknown) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };
  if (patch.name !== undefined) put("name", requiredText(patch.name, "名称"));
  if (patch.appId !== undefined) put("app_id", requiredText(patch.appId, "app_id"));
  // 密码框留空是「不改」，不是把可用凭证擦掉。
  if (patch.appSecret?.trim()) put("app_secret", patch.appSecret.trim());
  if (patch.agentId !== undefined) put("agent_id", patch.agentId?.trim() || null);
  if (patch.workspacePath !== undefined) put("workspace_path", patch.workspacePath?.trim() || null);
  if (patch.enabled !== undefined) put("enabled", patch.enabled ? 1 : 0);
  if (sets.length === 0) return getLarkBot(id);
  put("updated_at", Date.now());
  values.push(id);
  getDB().prepare(`UPDATE lark_bots SET ${sets.join(", ")} WHERE id = ?`).run(...(values as never[]));
  return getLarkBot(id);
}

export function deleteLarkBot(id: string): boolean {
  return getDB().prepare("DELETE FROM lark_bots WHERE id = ?").run(id).changes > 0;
}

export function setLarkBotIdentity(id: string, openId: string | null, name: string | null): void {
  getDB().prepare(
    "UPDATE lark_bots SET bot_open_id = ?, bot_name = ?, updated_at = ? WHERE id = ?",
  ).run(openId, name, Date.now(), id);
}

export function setLarkBotConnection(
  id: string,
  state: { connectedAt?: number | null; error?: string | null },
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (state.connectedAt !== undefined) {
    sets.push("last_connected_at = ?");
    values.push(state.connectedAt);
  }
  if (state.error !== undefined) {
    sets.push("last_error = ?");
    values.push(state.error);
  }
  if (!sets.length) return;
  sets.push("updated_at = ?");
  values.push(Date.now(), id);
  getDB().prepare(`UPDATE lark_bots SET ${sets.join(", ")} WHERE id = ?`).run(...(values as never[]));
}

export function listLarkChats(botId: string): LarkChat[] {
  return (
    getDB().query(
      "SELECT * FROM lark_chats WHERE bot_id = ? ORDER BY last_message_at DESC, created_at DESC",
    ).all(botId) as ChatRow[]
  ).map(rowToChat);
}

export function getLarkChat(botId: string, chatId: string): LarkChat | null {
  const row = getDB().query(
    "SELECT * FROM lark_chats WHERE bot_id = ? AND chat_id = ?",
  ).get(botId, chatId) as ChatRow | undefined;
  return row ? rowToChat(row) : null;
}

export function ensureLarkChat(
  botId: string,
  chatId: string,
  chatType: LarkChatType,
  title: string,
  now: number,
): LarkChat {
  const current = getLarkChat(botId, chatId);
  if (current) {
    getDB().prepare(
      "UPDATE lark_chats SET chat_type = ?, title = COALESCE(NULLIF(?, ''), title), last_message_at = ? WHERE id = ?",
    ).run(chatType, title, now, current.id);
    return getLarkChat(botId, chatId)!;
  }
  try {
    getDB().prepare(
      `INSERT INTO lark_chats (id, bot_id, chat_id, chat_type, title, last_message_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(crypto.randomUUID(), botId, chatId, chatType, title || null, now, now);
  } catch (error) {
    // 多进程同时收到同一 chat 的不同消息时，UNIQUE 的赢家已经建好映射；其它错误不能吞。
    const raced = getLarkChat(botId, chatId);
    if (!raced) throw error;
  }
  return getLarkChat(botId, chatId)!;
}

export function bindLarkChatSession(chatRowId: string, sessionId: string): void {
  getDB().prepare("UPDATE lark_chats SET session_id = ? WHERE id = ?").run(sessionId, chatRowId);
}

export function advanceLarkChat(chatRowId: string, nodeId: string, now = Date.now()): void {
  getDB().prepare(
    "UPDATE lark_chats SET last_node_id = ?, last_message_at = ? WHERE id = ?",
  ).run(nodeId, now, chatRowId);
}

export function claimLarkInbox(messageId: string, botId: string): boolean {
  return claimLarkInboxIn(getDB(), messageId, botId);
}

export function getLarkInbox(messageId: string): {
  botId: string;
  status: LarkInboxStatus;
  nodeId: string | null;
} | null {
  const row = getDB().query(
    "SELECT bot_id, status, node_id FROM lark_inbox WHERE message_id = ?",
  ).get(messageId) as { bot_id: string; status: LarkInboxStatus; node_id: string | null } | undefined;
  return row ? { botId: row.bot_id, status: row.status, nodeId: row.node_id } : null;
}

export function updateLarkInbox(
  messageId: string,
  status: LarkInboxStatus,
  nodeId?: string | null,
): void {
  getDB().prepare("UPDATE lark_inbox SET status = ?, node_id = COALESCE(?, node_id) WHERE message_id = ?")
    .run(status, nodeId ?? null, messageId);
}
