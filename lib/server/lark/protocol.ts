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
    /** 消息在话题内时飞书会带；话题即树的关键字段（S134）。 */
    thread_id?: string;
    /** 回复链根消息 id。 */
    root_id?: string;
    /** 被引用（回复）的那条消息 id。 */
    parent_id?: string;
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
      /** 是否 @ 到机器人。群聊触发门控挪到了 im/policy.ts，这里只报事实。 */
      mentionedBot: boolean;
      threadId: string | null;
      rootId: string | null;
      parentId: string | null;
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

/**
 * 先挡自身消息；bot open_id 缺失时群聊严格 fail-closed（既剥不掉 mention 也判不了
 * 触发）。「群里要不要理这条消息」不在这里决定 —— 那是 im/policy.ts 的事，这里只把
 * 事实（@ 了没有、在哪个话题、引用了谁）如实归一化。
 */
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
  if (chatType === "group" && !botOpenId) {
    return { kind: "ignore", messageId, reason: "bot_open_id_missing" };
  }
  const mentionedBot = chatType === "group" && isBotMentioned(botOpenId, message.mentions);
  const base = {
    messageId,
    chatId: message.chat_id,
    chatType,
    senderOpenId,
    mentionedBot,
    threadId: message.thread_id || null,
    rootId: message.root_id || null,
    parentId: message.parent_id || null,
  };

  if (message.message_type !== "text") {
    return {
      kind: "message",
      ...base,
      text: null,
      unsupportedType: message.message_type ?? "unknown",
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
  return { kind: "message", ...base, text, unsupportedType: null };
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

type LarkDb = Pick<Database, "prepare">;

/** 只有唯一约束冲突代表飞书重投；磁盘/锁/schema 错误必须原样抛出。 */
export function claimLarkInboxIn(
  db: LarkDb,
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

// ── S134：话题 → 树、机器人出站消息 → 节点。纯 DB 助手，store.ts 包一层 getDB()。 ──

export function recordLarkOutboxIn(
  db: LarkDb,
  row: {
    messageId: string;
    botId: string;
    chatId: string;
    nodeId: string;
    threadId: string | null;
    now: number;
  },
): void {
  db.prepare(
    `INSERT OR REPLACE INTO lark_outbox (message_id, bot_id, chat_id, node_id, thread_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.messageId, row.botId, row.chatId, row.nodeId, row.threadId, row.now);
}

/** 机器人发过的回复优先，其次用户发过且已落节点的消息；两边都不认识返回 null。 */
export function nodeOfLarkMessageIn(db: LarkDb, botId: string, messageId: string): string | null {
  const out = db
    .prepare("SELECT node_id FROM lark_outbox WHERE message_id = ? AND bot_id = ?")
    .get(messageId, botId) as { node_id: string | null } | undefined;
  if (out?.node_id) return out.node_id;
  const inbox = db
    .prepare("SELECT node_id FROM lark_inbox WHERE message_id = ? AND bot_id = ?")
    .get(messageId, botId) as { node_id: string | null } | undefined;
  return inbox?.node_id ?? null;
}

export function upsertLarkThreadIn(
  db: LarkDb,
  row: {
    botId: string;
    chatId: string;
    threadId: string;
    sessionId: string;
    rootNodeId: string;
    lastNodeId: string;
    now: number;
  },
): void {
  db.prepare(
    `INSERT INTO lark_threads
       (id, bot_id, chat_id, thread_id, session_id, root_node_id, last_node_id, created_at, last_message_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(bot_id, thread_id) DO UPDATE SET
       last_node_id = excluded.last_node_id,
       last_message_at = excluded.last_message_at`,
  ).run(
    crypto.randomUUID(),
    row.botId,
    row.chatId,
    row.threadId,
    row.sessionId,
    row.rootNodeId,
    row.lastNodeId,
    row.now,
    row.now,
  );
}

export function larkThreadTailIn(db: LarkDb, botId: string, threadId: string): string | null {
  const row = db
    .prepare("SELECT last_node_id FROM lark_threads WHERE bot_id = ? AND thread_id = ?")
    .get(botId, threadId) as { last_node_id: string | null } | undefined;
  return row?.last_node_id ?? null;
}

/**
 * 飞书给机器人顶层推送开的新话题，第一次入站时 lark_threads 尚无记录。由 root_id
 * 反查 outbox，再沿节点父链找到树根并登记；不是本机器人出站消息则严格不回填。
 */
export function backfillLarkThreadFromOutboxIn(
  db: LarkDb,
  row: {
    botId: string;
    chatId: string;
    threadId: string;
    rootMessageId: string;
    now: number;
  },
): { sessionId: string; rootNodeId: string; lastNodeId: string } | null {
  const out = db
    .prepare(
      "SELECT node_id FROM lark_outbox WHERE message_id = ? AND bot_id = ? AND chat_id = ?",
    )
    .get(row.rootMessageId, row.botId, row.chatId) as { node_id: string } | undefined;
  if (!out?.node_id) return null;

  let current = out.node_id;
  let sessionId: string | null = null;
  let rootNodeId: string | null = null;
  for (let i = 0; i < 1_000; i++) {
    const node = db
      .prepare("SELECT session_id, parent_id FROM nodes WHERE id = ?")
      .get(current) as { session_id: string; parent_id: string | null } | undefined;
    if (!node) return null;
    sessionId = node.session_id;
    if (node.parent_id === null) {
      rootNodeId = current;
      break;
    }
    current = node.parent_id;
  }
  if (!sessionId || !rootNodeId) return null;

  upsertLarkThreadIn(db, {
    botId: row.botId,
    chatId: row.chatId,
    threadId: row.threadId,
    sessionId,
    rootNodeId,
    lastNodeId: out.node_id,
    now: row.now,
  });
  return { sessionId, rootNodeId, lastNodeId: out.node_id };
}

/** 测试与迁移共用的建表语句，避免两处 schema 各写各的。 */
export const LARK_THREAD_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS lark_threads (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    root_node_id TEXT NOT NULL,
    last_node_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_message_at INTEGER NOT NULL,
    UNIQUE(bot_id, thread_id)
  );
  CREATE TABLE IF NOT EXISTS lark_outbox (
    message_id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    thread_id TEXT,
    created_at INTEGER NOT NULL
  );
`;
