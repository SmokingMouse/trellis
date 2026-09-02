import "server-only";
import { LARK_TEXT_LIMIT } from "./protocol";
import {
  createLarkClient,
  sendLarkText,
  type LarkSdkClient,
  type LarkSentMessage,
} from "./sdk";
import {
  advanceLarkChat,
  getLarkBotRecord,
  getLarkChat,
  recordLarkOutbox,
} from "./store";

type PushBot = {
  appId: string;
  appSecret: string;
  enabled: boolean;
};

type PushChat = {
  id: string;
  chatType: "p2p" | "group";
};

export type TaskLarkPushDeps = {
  enabled: () => boolean;
  publicUrl: () => string | null | undefined;
  getBot: (id: string) => PushBot | null;
  getChat: (botId: string, chatId: string) => PushChat | null;
  createClient: (appId: string, appSecret: string) => LarkSdkClient;
  sendText: (args: {
    client: LarkSdkClient;
    chatId: string;
    markdown: string;
    mode: "plain";
  }) => Promise<LarkSentMessage>;
  recordOutbox: typeof recordLarkOutbox;
  advanceChat: typeof advanceLarkChat;
};

const DEFAULT_DEPS: TaskLarkPushDeps = {
  enabled: () => process.env.TRELLIS_LARK !== "off",
  publicUrl: () => process.env.TRELLIS_PUBLIC_URL,
  getBot: getLarkBotRecord,
  getChat: getLarkChat,
  createClient: createLarkClient,
  sendText: sendLarkText,
  recordOutbox: recordLarkOutbox,
  advanceChat: advanceLarkChat,
};

export type TaskLarkPushResult =
  | { status: "sent"; messageId: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: string };

/** 任务正文专用截断：有公开地址才输出可用绝对深链，否则不泄露无意义的相对路径。 */
export function taskLarkMarkdown(
  markdown: string,
  link: string,
  publicUrl: string | null | undefined = process.env.TRELLIS_PUBLIC_URL,
): string {
  const text = markdown.trim() || "（Agent 未返回文本）";
  if (text.length <= LARK_TEXT_LIMIT) return text;
  const base = publicUrl?.trim().replace(/\/+$/, "");
  const note = base
    ? `\n\n…（内容已截断，完整内容见 Trellis：${base}${link}）`
    : "\n\n…（内容已截断，完整内容见 Trellis 画布）";
  return `${text.slice(0, Math.max(0, LARK_TEXT_LIMIT - note.length))}${note}`;
}

/**
 * 定时任务的独立出站口。它不依赖 WS manager；任何失败只写日志，不向上抛，也不影响
 * task_run 留档和既有 notify。TRELLIS_LARK=off 时在读取凭证前即 dry-run。
 */
export async function pushTaskRunToLark(
  args: {
    botId: string;
    chatId: string;
    sessionId: string | null;
    nodeId: string | null;
    markdown: string;
  },
  deps: TaskLarkPushDeps = DEFAULT_DEPS,
): Promise<TaskLarkPushResult> {
  try {
    if (!deps.enabled()) {
      console.info(
        `[lark] dry-run push bot=${args.botId} chat=${args.chatId} node=${args.nodeId ?? "-"}`,
      );
      return { status: "skipped", reason: "TRELLIS_LARK=off" };
    }

    const bot = deps.getBot(args.botId);
    if (!bot?.enabled) {
      console.warn(`[lark] task push skipped: bot missing or disabled bot=${args.botId}`);
      return { status: "skipped", reason: "bot missing or disabled" };
    }
    const chat = deps.getChat(args.botId, args.chatId);
    if (!chat) {
      console.warn(`[lark] task push skipped: chat missing bot=${args.botId} chat=${args.chatId}`);
      return { status: "skipped", reason: "chat missing" };
    }

    const link = args.sessionId && args.nodeId
      ? `/?session=${args.sessionId}&node=${args.nodeId}`
      : "/";
    const sent = await deps.sendText({
      client: deps.createClient(bot.appId, bot.appSecret),
      chatId: args.chatId,
      markdown: taskLarkMarkdown(args.markdown, link, deps.publicUrl()),
      // 任务消息没有可引用的入站锚点；群聊必须顶层发送以成为话题根，私聊同样用
      // chat_id create，后续引用由 outbox、非引用消息由既有 p2p 链尾语义承接。
      mode: "plain",
    });
    if (!sent.messageId) {
      console.error(`[lark] task push returned no message_id bot=${args.botId} chat=${args.chatId}`);
      return { status: "error", reason: "missing message_id" };
    }
    if (args.nodeId) {
      deps.recordOutbox({
        messageId: sent.messageId,
        botId: args.botId,
        chatId: args.chatId,
        nodeId: args.nodeId,
        threadId: null,
        now: Date.now(),
      });
      if (chat.chatType === "p2p") deps.advanceChat(chat.id, args.nodeId);
    }
    return { status: "sent", messageId: sent.messageId };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[lark] task push failed bot=${args.botId} chat=${args.chatId}:`, error);
    return { status: "error", reason };
  }
}
