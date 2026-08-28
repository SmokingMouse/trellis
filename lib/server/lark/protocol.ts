import type { LarkChatType } from "@/lib/lark-types";
import { SQLiteError, type Database } from "bun:sqlite";

export const LARK_TEXT_LIMIT = 4_000;
const TRUNCATED_NOTE = "\n\n…（内容已截断，完整内容见 Trellis 会话）";

export type LarkMention = {
  key?: string;
  name?: string;
  id?: { open_id?: string };
};

export type LarkMessageEvent = {
  sender?: {
    sender_type?: string;
    sender_id?: { open_id?: string; user_id?: string; union_id?: string };
  };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: LarkMention[];
  };
};

export type ParsedIncoming =
  | { kind: "ignore"; messageId: string | null; reason: string }
  | {
      kind: "message";
      messageId: string;
      chatId: string;
      chatType: LarkChatType;
      text: string | null;
      unsupportedType: string | null;
      senderOpenId: string | null;
    };

/** 飞书 text 消息本质是 JSON 字符串；markdown 原样保留，客户端至少能完整阅读。 */
export function markdownToLarkText(markdown: string, limit = LARK_TEXT_LIMIT): string {
  const text = markdown.trim() || "（Agent 未返回文本，完整状态见 Trellis 会话）";
  if (text.length <= limit) return JSON.stringify({ text });
  const keep = Math.max(0, limit - TRUNCATED_NOTE.length);
  return JSON.stringify({ text: `${text.slice(0, keep)}${TRUNCATED_NOTE}` });
}

export function isBotMentioned(
  botOpenId: string | null | undefined,
  mentions: LarkMention[] | undefined,
): boolean {
  if (!botOpenId) return false;
  return mentions?.some((mention) => mention.id?.open_id === botOpenId) ?? false;
}

function stripBotMention(
  text: string,
  botOpenId: string,
  mentions: LarkMention[] | undefined,
): string {
  let next = text;
  for (const mention of mentions ?? []) {
    if (mention.id?.open_id !== botOpenId) continue;
    // content 里通常是可信 metadata 给出的 @_user_N key；部分客户端直接给 @名称。
    for (const token of [mention.key, mention.name ? `@${mention.name}` : undefined]) {
      if (!token) continue;
      next = next.replace(token, " ");
    }
  }
  return next.replace(/\s+/g, " ").trim();
}

/** 先挡自身消息，再做群 @ 门控；bot open_id 缺失时群聊严格 fail-closed。 */
export function parseIncomingEvent(
  event: LarkMessageEvent,
  botOpenId: string | null,
): ParsedIncoming {
  const message = event.message;
  const messageId = message?.message_id ?? null;
  const senderType = event.sender?.sender_type?.toLowerCase() ?? "";
  const senderOpenId = event.sender?.sender_id?.open_id ?? null;

  if (senderType !== "user" || (botOpenId && senderOpenId === botOpenId)) {
    return { kind: "ignore", messageId, reason: "bot_or_app_sender" };
  }
  if (!messageId || !message?.chat_id) {
    return { kind: "ignore", messageId, reason: "missing_identity" };
  }

  const chatType: LarkChatType = message.chat_type === "group" ? "group" : "p2p";
  if (chatType === "group") {
    if (!botOpenId) return { kind: "ignore", messageId, reason: "bot_open_id_missing" };
    if (!isBotMentioned(botOpenId, message.mentions)) {
      return { kind: "ignore", messageId, reason: "not_mentioned" };
    }
  }

  if (message.message_type !== "text") {
    return {
      kind: "message",
      messageId,
      chatId: message.chat_id,
      chatType,
      text: null,
      unsupportedType: message.message_type ?? "unknown",
      senderOpenId,
    };
  }

  let text = "";
  try {
    const content = JSON.parse(message.content ?? "{}") as { text?: unknown };
    text = typeof content.text === "string" ? content.text : "";
  } catch {
    return { kind: "ignore", messageId, reason: "invalid_text_content" };
  }
  if (chatType === "group" && botOpenId) {
    text = stripBotMention(text, botOpenId, message.mentions);
  }
  if (!text.trim()) return { kind: "ignore", messageId, reason: "empty_text" };
  return {
    kind: "message",
    messageId,
    chatId: message.chat_id,
    chatType,
    text,
    unsupportedType: null,
    senderOpenId,
  };
}

export type DesiredConnection = { id: string; fingerprint: string };

/** manager 的副作用外壳只消费这份 diff，测试无需真的打开 WebSocket。 */
export function diffLarkConnections(
  desired: DesiredConnection[],
  active: DesiredConnection[],
): { connect: string[]; disconnect: string[] } {
  const want = new Map(desired.map((item) => [item.id, item.fingerprint]));
  const have = new Map(active.map((item) => [item.id, item.fingerprint]));
  const disconnect = [...have]
    .filter(([id, fingerprint]) => want.get(id) !== fingerprint)
    .map(([id]) => id)
    .sort();
  const connect = [...want]
    .filter(([id, fingerprint]) => have.get(id) !== fingerprint)
    .map(([id]) => id)
    .sort();
  return { connect, disconnect };
}

/** 只有唯一约束冲突代表飞书重投；磁盘/锁/schema 错误必须原样抛出。 */
export function claimLarkInboxIn(
  db: Pick<Database, "prepare">,
  messageId: string,
  botId: string,
): boolean {
  try {
    db.prepare(
      `INSERT INTO lark_inbox (message_id, bot_id, status)
       VALUES (?, ?, 'processing')`,
    ).run(messageId, botId);
    return true;
  } catch (error) {
    const code = error instanceof SQLiteError ? error.code : undefined;
    if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      return false;
    }
    throw error;
  }
}
