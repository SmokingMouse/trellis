import "server-only";
import fs from "node:fs";
import { DEFAULT_PROVIDER, providerFamily } from "@/lib/llm";
import { getProvider } from "@/lib/llm/server";
import { sessionCwd } from "@/lib/paths";
import { resolveAgentSpawn } from "@/lib/server/agent-pack";
import { getAgentBySlug, resolveEnabledAgent, type AgentRecord } from "@/lib/server/agents";
import {
  extractAgentSlug,
  resolveAddress,
  resolveTarget,
  type ImAddressReason,
  type ImInbound,
  type ImLookups,
  type ImTarget,
} from "@/lib/server/im/policy";
import {
  buildHistoryForNode,
  createBranchNode,
  createRootInSession,
  createSessionWithRoot,
  finalizeNode,
  getNode,
  getParentResumeId,
  getRootResumeIdForNode,
  getSession,
  setNodeAgent,
} from "@/lib/server/repo";
import { startRun } from "@/lib/server/run-bus";
import { getDB } from "@/lib/server/sqlite";
import { parseIncomingEvent, type LarkMessageEvent, type ParsedIncoming } from "./protocol";
import { AsyncSemaphore } from "./semaphore";
import {
  addLarkAck,
  resolveLarkChatTitle,
  sendLarkText,
  type LarkSdkClient,
  type LarkSendMode,
  type LarkSentMessage,
} from "./sdk";
import {
  advanceLarkChat,
  bindLarkChatSession,
  claimLarkInbox,
  ensureLarkChat,
  getLarkBotRecord,
  getLarkChat,
  getLarkInbox,
  larkThreadTail,
  nodeOfLarkMessage,
  recordLarkOutbox,
  updateLarkInbox,
  upsertLarkThread,
  type LarkBotRecord,
} from "./store";

const MAX_CHAT_QUEUE_DEPTH = 5;
const MAX_CONCURRENT_LARK_RUNS = 2;
/** @slug 外援看到的折叠历史深度，与画布 @agent 一致（app/api/chat/route.ts）。 */
const MENTION_HISTORY_DEPTH = 4;

type ParsedMessage = Extract<ParsedIncoming, { kind: "message" }>;
type QueuedMessage = ParsedMessage & { addressReason: ImAddressReason };
type ChatQueue = { tail: Promise<void>; depth: number };

const CHAT_QUEUES = new Map<string, ChatQueue>();
const GLOBAL_RUNS = new AsyncSemaphore(MAX_CONCURRENT_LARK_RUNS);

async function withGlobalRun<T>(fn: () => Promise<T>): Promise<T> {
  return GLOBAL_RUNS.run(fn);
}

function enqueueMessage(
  botId: string,
  client: LarkSdkClient,
  message: QueuedMessage,
): boolean {
  const key = `${botId}:${message.chatId}`;
  const current = CHAT_QUEUES.get(key) ?? { tail: Promise.resolve(), depth: 0 };
  if (current.depth >= MAX_CHAT_QUEUE_DEPTH) return false;
  current.depth++;
  const task = current.tail
    .catch(() => undefined)
    .then(() => withGlobalRun(() => processQueuedMessage(botId, client, message)));
  current.tail = task.finally(() => {
    current.depth--;
    if (current.depth === 0 && CHAT_QUEUES.get(key) === current) CHAT_QUEUES.delete(key);
  });
  current.tail.catch((error) => console.error("[lark] 消息处理失败", error));
  CHAT_QUEUES.set(key, current);
  return true;
}

async function rejectOverflow(
  botId: string,
  client: LarkSdkClient,
  message: QueuedMessage,
): Promise<void> {
  try {
    await sendLarkText({
      client,
      chatId: message.chatId,
      replyToMessageId: message.messageId,
      markdown: "消息太多，稍后再发。",
    });
  } finally {
    updateLarkInbox(message.messageId, "error");
    console.warn(`[lark] chat queue overflow bot=${botId} chat=${message.chatId}`);
  }
}

/** 策略层需要的三个查表回调；全部只读，WS 回调里同步跑得起。 */
function lookupsFor(bot: LarkBotRecord, chatId: string): ImLookups {
  return {
    nodeOfMessage: (messageId) => nodeOfLarkMessage(bot.id, messageId),
    threadTail: (threadId) => larkThreadTail(bot.id, threadId),
    chatTail: () => getLarkChat(bot.id, chatId)?.lastNodeId ?? null,
  };
}

function toInbound(message: ParsedMessage, text: string): ImInbound {
  return {
    chatType: message.chatType,
    text,
    mentionedBot: message.mentionedBot,
    threadId: message.threadId,
    rootId: message.rootId,
    parentId: message.parentId,
  };
}

/** WS 回调只做去重、门控和入队，不能把 3 秒飞书事件 ACK 窗口耗在 agent run 上。 */
export function acceptLarkEvent(
  botId: string,
  client: LarkSdkClient,
  event: LarkMessageEvent,
): void {
  const bot = getLarkBotRecord(botId);
  if (!bot?.enabled) return;
  const parsed = parseIncomingEvent(event, bot.botOpenId);
  if (!parsed.messageId) return;
  if (!claimLarkInbox(parsed.messageId, botId)) {
    const existing = getLarkInbox(parsed.messageId);
    console.info(
      `[lark] duplicate message ignored id=${parsed.messageId} bot=${existing?.botId ?? "?"}` +
        ` status=${existing?.status ?? "?"} node=${existing?.nodeId ?? "-"}`,
    );
    return;
  }
  if (parsed.kind === "ignore") {
    updateLarkInbox(parsed.messageId, "ignored");
    return;
  }
  let queued: QueuedMessage;
  if (parsed.text === null) {
    // 非文本：私聊或被 @ 才回「暂只支持文本」，群里别人发的图片一律不理。
    if (parsed.chatType === "group" && !parsed.mentionedBot) {
      updateLarkInbox(parsed.messageId, "ignored");
      return;
    }
    queued = { ...parsed, addressReason: parsed.chatType === "p2p" ? "p2p" : "mention" };
  } else {
    const address = resolveAddress(toInbound(parsed, parsed.text), bot, lookupsFor(bot, parsed.chatId));
    if (!address.addressed) {
      updateLarkInbox(parsed.messageId, "ignored");
      return;
    }
    queued = { ...parsed, text: address.text, addressReason: address.reason };
  }
  if (!enqueueMessage(botId, client, queued)) {
    void rejectOverflow(botId, client, queued).catch((error) =>
      console.error("[lark] 队列超限提示发送失败", error),
    );
  }
}

type Turn = {
  chatRowId: string;
  sessionId: string;
  nodeId: string;
  mode: "chat" | "project";
  target: ImTarget;
};

function sessionOfNode(nodeId: string): string | null {
  const row = getDB()
    .prepare("SELECT session_id FROM nodes WHERE id = ?")
    .get(nodeId) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

/**
 * 落点由 im/policy 决定；这里只负责把决定变成节点：branch 接在指定节点下，root 在
 * chat 会话里再长一棵树（thread 策略下每个话题一棵），chat 会话不存在才新建。
 */
function createTurn(args: {
  bot: LarkBotRecord;
  message: QueuedMessage;
  title: string;
  question: string;
  now: number;
}): Turn {
  const { bot, message } = args;
  const chat = ensureLarkChat(bot.id, message.chatId, message.chatType, args.title, args.now);
  const mode = bot.workspacePath ? "project" : "chat";
  const liveSession = chat.sessionId ? getSession(chat.sessionId) : null;
  const target = resolveTarget(toInbound(message, args.question), bot, lookupsFor(bot, message.chatId));

  if (target.kind === "branch") {
    const parentSessionId = getNode(target.parentId) ? sessionOfNode(target.parentId) : null;
    if (parentSessionId) {
      const nodeId = crypto.randomUUID();
      createBranchNode({
        nodeId,
        parentId: target.parentId,
        question: args.question,
        parentAnchor: null,
        now: args.now,
        attachments: [],
      });
      if (!chat.sessionId) bindLarkChatSession(chat.id, parentSessionId);
      return { chatRowId: chat.id, sessionId: parentSessionId, nodeId, mode, target };
    }
    // 目标节点已被删：退化成该 chat 会话里的新树，而不是丢消息。
  }

  const nodeId = crypto.randomUUID();
  if (liveSession) {
    createRootInSession({
      sessionId: liveSession.id,
      nodeId,
      question: args.question,
      now: args.now,
      attachments: [],
    });
    return {
      chatRowId: chat.id,
      sessionId: liveSession.id,
      nodeId,
      mode,
      target: target.kind === "root" ? target : { kind: "root", via: "chat" },
    };
  }

  const sessionId = crypto.randomUUID();
  createSessionWithRoot({
    sessionId,
    nodeId,
    title: `💬 ${args.title}`,
    question: args.question,
    now: args.now,
    mode,
    workspacePath: bot.workspacePath,
    systemPrompt: null,
    model: DEFAULT_PROVIDER,
    agentId: bot.agentId,
    attachments: [],
  });
  getDB().prepare("UPDATE sessions SET kind = 'lark' WHERE id = ?").run(sessionId);
  bindLarkChatSession(chat.id, sessionId);
  return {
    chatRowId: chat.id,
    sessionId,
    nodeId,
    mode,
    target: target.kind === "root" ? target : { kind: "root", via: "chat" },
  };
}

function briefError(error: unknown): string {
  const line = (error instanceof Error ? error.message : String(error)).split("\n")[0].trim();
  return (line || "未知错误").slice(0, 180);
}

/** 群里按机器人配置回；私聊恒引用回复（私聊没有话题）。 */
function sendModeFor(bot: LarkBotRecord, message: QueuedMessage): LarkSendMode {
  return message.chatType === "group" ? bot.replyMode : "quote";
}

/** 回复发出后登记：出站消息 → 节点（引用回复分支的查表源）、话题 → 树叶子。 */
function registerSent(args: {
  bot: LarkBotRecord;
  message: QueuedMessage;
  turn: Turn;
  sent: LarkSentMessage;
  now: number;
}): void {
  const { bot, message, turn, sent } = args;
  const threadId = message.chatType === "group" ? sent.threadId ?? message.threadId : null;
  if (sent.messageId) {
    recordLarkOutbox({
      messageId: sent.messageId,
      botId: bot.id,
      chatId: message.chatId,
      nodeId: turn.nodeId,
      threadId,
      now: args.now,
    });
  }
  if (threadId) {
    upsertLarkThread({
      botId: bot.id,
      chatId: message.chatId,
      threadId,
      sessionId: turn.sessionId,
      rootNodeId: turn.nodeId,
      lastNodeId: turn.nodeId,
      now: args.now,
    });
  }
}

async function runAgentTurn(args: {
  bot: LarkBotRecord;
  client: LarkSdkClient;
  message: QueuedMessage;
  turn: Turn;
  question: string;
  mentionAgent: AgentRecord | null;
}): Promise<void> {
  const { bot, message, turn } = args;
  const family = providerFamily(DEFAULT_PROVIDER);
  const llm = getProvider(DEFAULT_PROVIDER, { mode: turn.mode });
  const spawnCwd = sessionCwd(turn.mode, bot.workspacePath);
  const mention = family !== "mock" ? args.mentionAgent : null;
  // @slug 外援与画布同语义：不 resume 主线（外援人设不能写进主线 CLI session）、
  // 不落盘、只看折叠的最近几轮。
  const resumeId = mention
    ? null
    : turn.mode === "project"
      ? getRootResumeIdForNode(turn.nodeId, family, bot.workspacePath)
      : getParentResumeId(turn.nodeId, family, spawnCwd);
  // transcript 被清理时退回 DB 历史，连续上下文退化但不静默归零。
  const history = mention
    ? buildHistoryForNode(turn.nodeId, { maxDepth: MENTION_HISTORY_DEPTH })
    : resumeId
      ? []
      : buildHistoryForNode(turn.nodeId, { maxDepth: 50 });
  const agentRecord = mention ?? (family !== "mock" ? resolveEnabledAgent(bot.agentId) : null);
  const agentSpawn = agentRecord && family !== "mock"
    ? resolveAgentSpawn(agentRecord, family, bot.workspacePath)
    : null;
  if (agentRecord) setNodeAgent(turn.nodeId, agentRecord.id, mention ? "mention" : "session");

  await new Promise<void>((resolve, reject) => {
    try {
      startRun({
        nodeId: turn.nodeId,
        sessionIdTarget: mention
          ? undefined
          : turn.mode === "project"
            ? resumeId
              ? undefined
              : "root"
            : "node",
        resumeFamily: family,
        interactive: false,
        factory: (signal) => llm.stream({
          history,
          question: args.question,
          parentAnchor: null,
          signal,
          platform: { sessionId: turn.sessionId, nodeId: turn.nodeId },
          claudeSessionId: resumeId,
          cwd: spawnCwd,
          systemPrompt: null,
          agent: agentSpawn,
          ephemeral: !!mention,
          chatEnhanced: turn.mode === "chat",
          forkSession: !mention && turn.mode === "chat",
          attachments: [],
        }),
        onSettled: (result) => {
          void (async () => {
            const node = getNode(turn.nodeId);
            const now = Date.now();
            if (result.status === "done" && node?.response.trim()) {
              const sent = await sendLarkText({
                client: args.client,
                chatId: message.chatId,
                replyToMessageId: message.messageId,
                markdown: node.response,
                mode: sendModeFor(bot, message),
              });
              registerSent({ bot, message, turn, sent, now });
              updateLarkInbox(message.messageId, "done", turn.nodeId);
            } else {
              const reason = briefError(result.errorMessage || "Agent 未返回文本");
              const sent = await sendLarkText({
                client: args.client,
                chatId: message.chatId,
                replyToMessageId: message.messageId,
                markdown: `Agent 执行失败：${reason}。详情见 Trellis 会话。`,
                mode: sendModeFor(bot, message),
              });
              registerSent({ bot, message, turn, sent, now });
              updateLarkInbox(message.messageId, "error", turn.nodeId);
            }
          })().then(resolve, reject);
        },
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function processQueuedMessage(
  botId: string,
  client: LarkSdkClient,
  message: QueuedMessage,
): Promise<void> {
  const bot = getLarkBotRecord(botId);
  if (!bot?.enabled) {
    updateLarkInbox(message.messageId, "ignored");
    return;
  }
  if (message.unsupportedType) {
    await sendLarkText({
      client,
      chatId: message.chatId,
      replyToMessageId: message.messageId,
      markdown: "暂只支持文本。",
    });
    updateLarkInbox(message.messageId, "done");
    return;
  }

  if (bot.ackMode === "reaction") {
    void addLarkAck(client, message.messageId).catch((error) =>
      console.warn("[lark] ack reaction 失败", error),
    );
  }
  const title = await resolveLarkChatTitle(
    client,
    message.chatId,
    message.chatType,
    message.senderOpenId,
  );
  // @slug 单轮外援：只认已启用 agent 的 slug，普通 @文本 不会被误吃。
  const extracted = extractAgentSlug(message.text!, (slug) => !!getAgentBySlug(slug)?.enabled);
  const mentionAgent = extracted.slug ? getAgentBySlug(extracted.slug) : null;
  const question = extracted.text;

  let turn: Turn | null = null;
  try {
    turn = createTurn({ bot, message, title, question, now: Date.now() });
    updateLarkInbox(message.messageId, "processing", turn.nodeId);
    console.info(
      `[lark] turn bot=${bot.id} chat=${message.chatType} via=${message.addressReason}` +
        ` target=${turn.target.kind}/${turn.target.via} node=${turn.nodeId}` +
        (mentionAgent ? ` mention=@${mentionAgent.slug}` : ""),
    );
    if (bot.workspacePath && !fs.existsSync(bot.workspacePath)) {
      throw new Error(`工作目录不存在：${bot.workspacePath}`);
    }
    await runAgentTurn({ bot, client, message, turn, question, mentionAgent });
    advanceLarkChat(turn.chatRowId, turn.nodeId);
  } catch (error) {
    const reason = briefError(error);
    if (turn) {
      const node = getNode(turn.nodeId);
      if (node?.status === "streaming") {
        finalizeNode({
          nodeId: turn.nodeId,
          status: "error",
          errorMessage: reason,
          tokenInput: 0,
          tokenOutput: 0,
          tokenCacheRead: 0,
          tokenCacheCreation: 0,
          now: Date.now(),
        });
      }
      advanceLarkChat(turn.chatRowId, turn.nodeId);
    }
    updateLarkInbox(message.messageId, "error", turn?.nodeId);
    await sendLarkText({
      client,
      chatId: message.chatId,
      replyToMessageId: message.messageId,
      markdown: `Agent 执行失败：${reason}。详情见 Trellis 会话。`,
      mode: sendModeFor(bot, message),
    });
  }
}
