import "server-only";
import fs from "node:fs";
import { DEFAULT_PROVIDER, providerFamily } from "@/lib/llm";
import { getProvider } from "@/lib/llm/server";
import type { LarkChatType } from "@/lib/lark-types";
import { sessionCwd } from "@/lib/paths";
import { resolveAgentSpawn } from "@/lib/server/agent-pack";
import { resolveEnabledAgent } from "@/lib/server/agents";
import {
  buildHistoryForNode,
  createBranchNode,
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
} from "./sdk";
import {
  advanceLarkChat,
  bindLarkChatSession,
  claimLarkInbox,
  ensureLarkChat,
  getLarkBotRecord,
  getLarkInbox,
  updateLarkInbox,
  type LarkBotRecord,
} from "./store";

const MAX_CHAT_QUEUE_DEPTH = 5;
const MAX_CONCURRENT_LARK_RUNS = 2;

type QueuedMessage = Extract<ParsedIncoming, { kind: "message" }>;
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
  if (!enqueueMessage(botId, client, parsed)) {
    void rejectOverflow(botId, client, parsed).catch((error) =>
      console.error("[lark] 队列超限提示发送失败", error),
    );
  }
}

function createTurn(args: {
  bot: LarkBotRecord;
  chatId: string;
  chatType: LarkChatType;
  title: string;
  question: string;
  now: number;
}): { chatRowId: string; sessionId: string; nodeId: string; mode: "chat" | "project" } {
  const chat = ensureLarkChat(args.bot.id, args.chatId, args.chatType, args.title, args.now);
  const mode = args.bot.workspacePath ? "project" : "chat";
  const liveSession = chat.sessionId ? getSession(chat.sessionId) : null;
  const parentId = chat.lastNodeId ?? liveSession?.rootNodeId ?? null;

  if (liveSession && parentId && getNode(parentId)) {
    const nodeId = crypto.randomUUID();
    createBranchNode({
      nodeId,
      parentId,
      question: args.question,
      parentAnchor: null,
      now: args.now,
      attachments: [],
    });
    return { chatRowId: chat.id, sessionId: liveSession.id, nodeId, mode };
  }

  const sessionId = crypto.randomUUID();
  const nodeId = crypto.randomUUID();
  createSessionWithRoot({
    sessionId,
    nodeId,
    title: `💬 ${args.title}`,
    question: args.question,
    now: args.now,
    mode,
    workspacePath: args.bot.workspacePath,
    systemPrompt: null,
    model: DEFAULT_PROVIDER,
    agentId: args.bot.agentId,
    attachments: [],
  });
  getDB().prepare("UPDATE sessions SET kind = 'lark' WHERE id = ?").run(sessionId);
  bindLarkChatSession(chat.id, sessionId);
  return { chatRowId: chat.id, sessionId, nodeId, mode };
}

function briefError(error: unknown): string {
  const line = (error instanceof Error ? error.message : String(error)).split("\n")[0].trim();
  return (line || "未知错误").slice(0, 180);
}

async function runAgentTurn(args: {
  bot: LarkBotRecord;
  client: LarkSdkClient;
  message: QueuedMessage;
  sessionId: string;
  nodeId: string;
  mode: "chat" | "project";
}): Promise<void> {
  const family = providerFamily(DEFAULT_PROVIDER);
  const llm = getProvider(DEFAULT_PROVIDER, { mode: args.mode });
  const spawnCwd = sessionCwd(args.mode, args.bot.workspacePath);
  const resumeId = args.mode === "project"
    ? getRootResumeIdForNode(args.nodeId, family, args.bot.workspacePath)
    : getParentResumeId(args.nodeId, family, spawnCwd);
  // transcript 被清理时退回 DB 历史，连续上下文退化但不静默归零。
  const history = resumeId ? [] : buildHistoryForNode(args.nodeId, { maxDepth: 50 });
  const agentRecord = family !== "mock" ? resolveEnabledAgent(args.bot.agentId) : null;
  const agentSpawn = agentRecord && family !== "mock"
    ? resolveAgentSpawn(agentRecord, family, args.bot.workspacePath)
    : null;
  if (agentRecord) setNodeAgent(args.nodeId, agentRecord.id, "session");

  await new Promise<void>((resolve, reject) => {
    try {
      startRun({
        nodeId: args.nodeId,
        sessionIdTarget: args.mode === "project" ? (resumeId ? undefined : "root") : "node",
        resumeFamily: family,
        interactive: false,
        factory: (signal) => llm.stream({
          history,
          question: args.message.text!,
          parentAnchor: null,
          signal,
          claudeSessionId: resumeId,
          cwd: spawnCwd,
          systemPrompt: null,
          agent: agentSpawn,
          chatEnhanced: args.mode === "chat",
          forkSession: args.mode === "chat",
          attachments: [],
        }),
        onSettled: (result) => {
          void (async () => {
            const node = getNode(args.nodeId);
            if (result.status === "done" && node?.response.trim()) {
              await sendLarkText({
                client: args.client,
                chatId: args.message.chatId,
                replyToMessageId: args.message.messageId,
                markdown: node.response,
              });
              updateLarkInbox(args.message.messageId, "done", args.nodeId);
            } else {
              const reason = briefError(result.errorMessage || "Agent 未返回文本");
              await sendLarkText({
                client: args.client,
                chatId: args.message.chatId,
                replyToMessageId: args.message.messageId,
                markdown: `Agent 执行失败：${reason}。详情见 Trellis 会话。`,
              });
              updateLarkInbox(args.message.messageId, "error", args.nodeId);
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

  void addLarkAck(client, message.messageId).catch((error) =>
    console.warn("[lark] ack reaction 失败", error),
  );
  const title = await resolveLarkChatTitle(
    client,
    message.chatId,
    message.chatType,
    message.senderOpenId,
  );
  let turn: ReturnType<typeof createTurn> | null = null;
  try {
    turn = createTurn({
      bot,
      chatId: message.chatId,
      chatType: message.chatType,
      title,
      question: message.text!,
      now: Date.now(),
    });
    updateLarkInbox(message.messageId, "processing", turn.nodeId);
    if (bot.workspacePath && !fs.existsSync(bot.workspacePath)) {
      throw new Error(`工作目录不存在：${bot.workspacePath}`);
    }
    await runAgentTurn({ bot, client, message, ...turn });
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
    });
  }
}
