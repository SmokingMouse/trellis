import "server-only";
import crypto from "node:crypto";
import {
  LARK_ACK_MODES,
  LARK_ACCESS_MODES,
  LARK_GROUP_TRIGGERS,
  LARK_MEMBER_ROLES,
  LARK_MEMBER_STATUSES,
  LARK_POLICY_DEFAULTS,
  LARK_REPLY_MODES,
  LARK_SESSION_POLICIES,
  type LarkAccessMode,
  type LarkBot,
  type LarkBotInput,
  type LarkBotMember,
  type LarkBotMemberRole,
  type LarkBotMemberStatus,
  type LarkBotPolicy,
  type LarkChat,
  type LarkChatType,
  type LarkInboxStatus,
} from "@/lib/lark-types";
import { getDB } from "@/lib/server/sqlite";
import {
  backfillLarkThreadFromOutboxIn,
  claimLarkInboxIn,
  larkThreadTailIn,
  nodeOfLarkMessageIn,
  recordLarkOutboxIn,
  upsertLarkThreadIn,
} from "./protocol";

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
  group_trigger: string | null;
  trigger_prefix: string | null;
  reply_mode: string | null;
  session_policy: string | null;
  ack_mode: string | null;
  access_mode: string | null;
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

export type MemberRow = {
  id: string;
  bot_id: string;
  open_id: string;
  role: string;
  status: string;
  code: string;
  name: string | null;
  pending_message: string | null;
  pending_preview: string | null;
  pending_chat_id: string | null;
  last_sender_notified_at: number | null;
  last_admin_notified_at: number | null;
  applied_at: number;
  decided_at: number | null;
  decided_by: string | null;
  created_at: number;
  updated_at: number;
};

const BOT_COLUMNS = `id, name, app_id, app_secret, agent_id, workspace_path, enabled,
  bot_open_id, bot_name, last_connected_at, last_error, created_at, updated_at,
  group_trigger, trigger_prefix, reply_mode, session_policy, ack_mode, access_mode`;

const MEMBER_COLUMNS = `id, bot_id, open_id, role, status, code, name,
  pending_message, pending_preview, pending_chat_id,
  last_sender_notified_at, last_admin_notified_at,
  applied_at, decided_at, decided_by, created_at, updated_at`;

/** 读侧宽容：库里出现未知值（手改 / 老版本回滚）退回默认，而不是让整个机器人列表炸掉。 */
function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** 写侧严格：API 传来不认识的档位直接拒，错误文案含「取值无效」让 route 判成 400。 */
function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${field} 取值无效：${String(value)}（可选 ${allowed.join(" / ")}）`);
}

function rowToPolicy(row: BotRow): LarkBotPolicy {
  const d = LARK_POLICY_DEFAULTS;
  return {
    groupTrigger: asEnum(row.group_trigger, LARK_GROUP_TRIGGERS, d.groupTrigger),
    triggerPrefix: row.trigger_prefix?.trim() || null,
    sessionPolicy: asEnum(row.session_policy, LARK_SESSION_POLICIES, d.sessionPolicy),
    replyMode: asEnum(row.reply_mode, LARK_REPLY_MODES, d.replyMode),
    ackMode: asEnum(row.ack_mode, LARK_ACK_MODES, d.ackMode),
    accessMode: asEnum(row.access_mode, LARK_ACCESS_MODES, d.accessMode),
  };
}

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
    ...rowToPolicy(row),
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

export type LarkBotMemberRecord = LarkBotMember & {
  pendingMessage: string | null;
  lastSenderNotifiedAt: number | null;
  lastAdminNotifiedAt: number | null;
};

function rowToMember(row: MemberRow): LarkBotMemberRecord {
  return {
    id: row.id,
    botId: row.bot_id,
    openId: row.open_id,
    role: asEnum(row.role, LARK_MEMBER_ROLES, "member"),
    status: asEnum(row.status, LARK_MEMBER_STATUSES, "pending"),
    code: row.code,
    name: row.name,
    pendingMessage: row.pending_message,
    pendingPreview: row.pending_preview,
    pendingChatId: row.pending_chat_id,
    lastSenderNotifiedAt: row.last_sender_notified_at,
    lastAdminNotifiedAt: row.last_admin_notified_at,
    appliedAt: row.applied_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
  const d = LARK_POLICY_DEFAULTS;
  const policy: LarkBotPolicy = {
    groupTrigger: input.groupTrigger === undefined
      ? d.groupTrigger
      : requireEnum(input.groupTrigger, LARK_GROUP_TRIGGERS, "groupTrigger"),
    triggerPrefix: input.triggerPrefix?.trim() || null,
    sessionPolicy: input.sessionPolicy === undefined
      ? d.sessionPolicy
      : requireEnum(input.sessionPolicy, LARK_SESSION_POLICIES, "sessionPolicy"),
    replyMode: input.replyMode === undefined
      ? d.replyMode
      : requireEnum(input.replyMode, LARK_REPLY_MODES, "replyMode"),
    ackMode: input.ackMode === undefined
      ? d.ackMode
      : requireEnum(input.ackMode, LARK_ACK_MODES, "ackMode"),
    accessMode: input.accessMode === undefined
      ? d.accessMode
      : requireEnum(input.accessMode, LARK_ACCESS_MODES, "accessMode"),
  };
  getDB().prepare(
    `INSERT INTO lark_bots
      (id, name, app_id, app_secret, agent_id, workspace_path, enabled, created_at, updated_at,
       group_trigger, trigger_prefix, reply_mode, session_policy, ack_mode, access_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    policy.groupTrigger,
    policy.triggerPrefix,
    policy.replyMode,
    policy.sessionPolicy,
    policy.ackMode,
    policy.accessMode,
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
  // S134 四旋钮 + accessMode：undefined = 不改；给了就必须是合法档位。
  if (patch.groupTrigger !== undefined) {
    put("group_trigger", requireEnum(patch.groupTrigger, LARK_GROUP_TRIGGERS, "groupTrigger"));
  }
  if (patch.triggerPrefix !== undefined) put("trigger_prefix", patch.triggerPrefix?.trim() || null);
  if (patch.sessionPolicy !== undefined) {
    put("session_policy", requireEnum(patch.sessionPolicy, LARK_SESSION_POLICIES, "sessionPolicy"));
  }
  if (patch.replyMode !== undefined) {
    put("reply_mode", requireEnum(patch.replyMode, LARK_REPLY_MODES, "replyMode"));
  }
  if (patch.ackMode !== undefined) {
    put("ack_mode", requireEnum(patch.ackMode, LARK_ACK_MODES, "ackMode"));
  }
  if (patch.accessMode !== undefined) {
    put("access_mode", requireEnum(patch.accessMode, LARK_ACCESS_MODES, "accessMode"));
  }
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
  title: string | null,
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

// ── S134：话题 → 树、机器人出站消息 → 节点（im/policy 的三个查表回调用这些） ──

export function recordLarkOutbox(row: {
  messageId: string;
  botId: string;
  chatId: string;
  nodeId: string;
  threadId: string | null;
  now: number;
}): void {
  recordLarkOutboxIn(getDB(), row);
}

export function nodeOfLarkMessage(botId: string, messageId: string): string | null {
  return nodeOfLarkMessageIn(getDB(), botId, messageId);
}

export function upsertLarkThread(row: {
  botId: string;
  chatId: string;
  threadId: string;
  sessionId: string;
  rootNodeId: string;
  lastNodeId: string;
  now: number;
}): void {
  upsertLarkThreadIn(getDB(), row);
}

export function larkThreadTail(botId: string, threadId: string): string | null {
  return larkThreadTailIn(getDB(), botId, threadId);
}

// ── 对话权限审批（fj-access）：成员与管理员管理 ──

export function generateMemberCode(botId: string): string {
  const db = getDB();
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = crypto.randomBytes(2).toString("hex").toLowerCase();
    const existing = db
      .prepare("SELECT 1 FROM lark_bot_members WHERE bot_id = ? AND code = ?")
      .get(botId, code);
    if (!existing) return code;
  }
  return crypto.randomBytes(4).toString("hex").slice(0, 4).toLowerCase();
}

export function listLarkBotMembers(botId: string): LarkBotMemberRecord[] {
  return (
    getDB()
      .query(`SELECT ${MEMBER_COLUMNS} FROM lark_bot_members WHERE bot_id = ? ORDER BY applied_at DESC, created_at DESC`)
      .all(botId) as MemberRow[]
  ).map(rowToMember);
}

export function listLarkBotAdmins(botId: string): LarkBotMemberRecord[] {
  return (
    getDB()
      .query(
        `SELECT ${MEMBER_COLUMNS} FROM lark_bot_members WHERE bot_id = ? AND role = 'admin' AND status = 'approved' ORDER BY created_at ASC`,
      )
      .all(botId) as MemberRow[]
  ).map(rowToMember);
}

export function getLarkBotMember(botId: string, openId: string): LarkBotMemberRecord | null {
  const row = getDB()
    .query(`SELECT ${MEMBER_COLUMNS} FROM lark_bot_members WHERE bot_id = ? AND open_id = ?`)
    .get(botId, openId) as MemberRow | undefined;
  return row ? rowToMember(row) : null;
}

export function getLarkBotMemberByCode(botId: string, code: string): LarkBotMemberRecord | null {
  const cleanCode = code.trim().toLowerCase();
  const row = getDB()
    .query(`SELECT ${MEMBER_COLUMNS} FROM lark_bot_members WHERE bot_id = ? AND LOWER(code) = ?`)
    .get(botId, cleanCode) as MemberRow | undefined;
  return row ? rowToMember(row) : null;
}

export function getLarkBotMemberById(id: string): LarkBotMemberRecord | null {
  const row = getDB()
    .query(`SELECT ${MEMBER_COLUMNS} FROM lark_bot_members WHERE id = ?`)
    .get(id) as MemberRow | undefined;
  return row ? rowToMember(row) : null;
}

export function upsertPendingMember(args: {
  botId: string;
  openId: string;
  name?: string | null;
  pendingMessage: unknown;
  pendingPreview: string;
  pendingChatId: string;
  now?: number;
}): {
  member: LarkBotMemberRecord;
  shouldNotifySender: boolean;
  shouldNotifyAdmin: boolean;
} {
  const now = args.now ?? Date.now();
  const preview = args.pendingPreview.slice(0, 200);
  const pendingMsgJson = JSON.stringify(args.pendingMessage);
  const existing = getLarkBotMember(args.botId, args.openId);

  if (existing) {
    // 已经 approved 的用户不进入 pending
    if (existing.status === "approved") {
      return { member: existing, shouldNotifySender: false, shouldNotifyAdmin: false };
    }
    // 24 小时内同一申请人不重复提示发送人
    const shouldNotifySender =
      !existing.lastSenderNotifiedAt || now - existing.lastSenderNotifiedAt >= 24 * 3600 * 1000;
    // 1 小时内同一申请人不重复通知 admin
    const shouldNotifyAdmin =
      !existing.lastAdminNotifiedAt || now - existing.lastAdminNotifiedAt >= 3600 * 1000;

    const nextSenderNotified = shouldNotifySender ? now : existing.lastSenderNotifiedAt;
    const nextAdminNotified = shouldNotifyAdmin ? now : existing.lastAdminNotifiedAt;

    getDB().prepare(
      `UPDATE lark_bot_members SET
        status = 'pending',
        pending_message = ?,
        pending_preview = ?,
        pending_chat_id = ?,
        name = COALESCE(?, name),
        last_sender_notified_at = ?,
        last_admin_notified_at = ?,
        applied_at = ?,
        updated_at = ?
       WHERE id = ?`,
    ).run(
      pendingMsgJson,
      preview,
      args.pendingChatId,
      args.name || null,
      nextSenderNotified,
      nextAdminNotified,
      now,
      now,
      existing.id,
    );

    return {
      member: getLarkBotMember(args.botId, args.openId)!,
      shouldNotifySender,
      shouldNotifyAdmin,
    };
  }

  // 新建申请
  const id = crypto.randomUUID();
  const code = generateMemberCode(args.botId);
  getDB().prepare(
    `INSERT INTO lark_bot_members
      (id, bot_id, open_id, role, status, code, name, pending_message, pending_preview, pending_chat_id,
       last_sender_notified_at, last_admin_notified_at, applied_at, created_at, updated_at)
     VALUES (?, ?, ?, 'member', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    args.botId,
    args.openId,
    code,
    args.name || null,
    pendingMsgJson,
    preview,
    args.pendingChatId,
    now,
    now,
    now,
    now,
    now,
  );

  return {
    member: getLarkBotMember(args.botId, args.openId)!,
    shouldNotifySender: true,
    shouldNotifyAdmin: true,
  };
}

export function preapproveMember(args: {
  botId: string;
  openId: string;
  role?: LarkBotMemberRole;
  name?: string | null;
  now?: number;
}): LarkBotMemberRecord {
  const now = args.now ?? Date.now();
  const role = args.role ?? "member";
  const existing = getLarkBotMember(args.botId, args.openId);
  if (existing) {
    getDB().prepare(
      `UPDATE lark_bot_members SET
        status = 'approved',
        role = ?,
        name = COALESCE(?, name),
        decided_at = ?,
        decided_by = 'admin',
        updated_at = ?
       WHERE id = ?`,
    ).run(role, args.name || null, now, now, existing.id);
    return getLarkBotMember(args.botId, args.openId)!;
  }
  const id = crypto.randomUUID();
  const code = generateMemberCode(args.botId);
  getDB().prepare(
    `INSERT INTO lark_bot_members
      (id, bot_id, open_id, role, status, code, name, applied_at, decided_at, decided_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?, 'admin', ?, ?)`,
  ).run(
    id,
    args.botId,
    args.openId,
    role,
    code,
    args.name || null,
    now,
    now,
    now,
    now,
  );
  return getLarkBotMember(args.botId, args.openId)!;
}

export function updateMemberRole(
  botId: string,
  openId: string,
  role: LarkBotMemberRole,
): LarkBotMemberRecord | null {
  const existing = getLarkBotMember(botId, openId);
  if (!existing) return null;
  getDB().prepare(
    "UPDATE lark_bot_members SET role = ?, updated_at = ? WHERE id = ?",
  ).run(role, Date.now(), existing.id);
  return getLarkBotMember(botId, openId);
}

export function setMemberDecision(args: {
  botId: string;
  openId: string;
  status: LarkBotMemberStatus;
  decidedBy: string;
  now?: number;
}): LarkBotMemberRecord | null {
  const existing = getLarkBotMember(args.botId, args.openId);
  if (!existing) return null;
  const now = args.now ?? Date.now();
  getDB().prepare(
    `UPDATE lark_bot_members SET
      status = ?,
      decided_at = ?,
      decided_by = ?,
      updated_at = ?
     WHERE id = ?`,
  ).run(args.status, now, args.decidedBy, now, existing.id);
  return getLarkBotMember(args.botId, args.openId);
}

export function clearMemberPendingMessage(botId: string, openId: string): void {
  getDB().prepare(
    `UPDATE lark_bot_members SET
      pending_message = NULL,
      pending_preview = NULL,
      pending_chat_id = NULL,
      updated_at = ?
     WHERE bot_id = ? AND open_id = ?`,
  ).run(Date.now(), botId, openId);
}

/**
 * 原子领取并清空挂起消息：并发的多次批准 / 拒绝里只有一次拿得到，其余拿到 null。
 * 「还有没有挂起消息」和「清空」必须在同一个 IMMEDIATE 事务里——先读快照、await 网络
 * 之后才清空，两次审批就会各重放一遍（review-access F1，同 claimLarkInboxIn 的去重范式）。
 */
export function takeMemberPendingMessage(
  botId: string,
  openId: string,
  now = Date.now(),
): { pendingMessage: string; pendingChatId: string | null; appliedAt: number } | null {
  const db = getDB();
  const take = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT pending_message, pending_chat_id, applied_at FROM lark_bot_members
         WHERE bot_id = ? AND open_id = ? AND pending_message IS NOT NULL`,
      )
      .get(botId, openId) as
      | { pending_message: string; pending_chat_id: string | null; applied_at: number }
      | null;
    if (!row) return null;
    db.prepare(
      `UPDATE lark_bot_members SET
        pending_message = NULL,
        pending_preview = NULL,
        pending_chat_id = NULL,
        updated_at = ?
       WHERE bot_id = ? AND open_id = ?`,
    ).run(now, botId, openId);
    return {
      pendingMessage: row.pending_message,
      pendingChatId: row.pending_chat_id,
      appliedAt: row.applied_at,
    };
  });
  return take.immediate();
}

export function deleteLarkBotMember(botId: string, openId: string): boolean {
  return (
    getDB().prepare("DELETE FROM lark_bot_members WHERE bot_id = ? AND open_id = ?").run(botId, openId)
      .changes > 0
  );
}

export function deleteLarkBotMemberById(id: string): boolean {
  return getDB().prepare("DELETE FROM lark_bot_members WHERE id = ?").run(id).changes > 0;
}


export function backfillLarkThreadFromOutbox(row: {
  botId: string;
  chatId: string;
  threadId: string;
  rootMessageId: string;
  now: number;
}): { sessionId: string; rootNodeId: string; lastNodeId: string } | null {
  return backfillLarkThreadFromOutboxIn(getDB(), row);
}
