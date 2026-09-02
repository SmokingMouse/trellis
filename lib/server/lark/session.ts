import "server-only";
import { DEFAULT_PROVIDER } from "@/lib/llm";
import {
  createRootInSession,
  createSessionWithRoot,
  getSession,
} from "@/lib/server/repo";
import { getDB } from "@/lib/server/sqlite";
import type { LarkChatType } from "@/lib/lark-types";
import { bindLarkChatSession, ensureLarkChat } from "./store";

type LarkSessionBot = {
  id: string;
  agentId: string | null;
  workspacePath: string | null;
};

/**
 * chat → kind='lark' 会话 → 新根的唯一实现。入站消息和定时任务都走这里，避免
 * 两条链对「chat 尚无会话 / 会话指针悬挂」得出不同答案。
 */
export function createRootInLarkChat(args: {
  bot: LarkSessionBot;
  chatId: string;
  chatType: LarkChatType;
  title: string;
  question: string;
  now: number;
  nodeId?: string;
}): {
  chatRowId: string;
  sessionId: string;
  nodeId: string;
  mode: "chat" | "project";
} {
  const chat = ensureLarkChat(
    args.bot.id,
    args.chatId,
    args.chatType,
    args.title,
    args.now,
  );
  const nodeId = args.nodeId ?? crypto.randomUUID();
  const mode = args.bot.workspacePath ? "project" : "chat";
  const liveSession = chat.sessionId ? getSession(chat.sessionId) : null;
  if (liveSession) {
    createRootInSession({
      sessionId: liveSession.id,
      nodeId,
      question: args.question,
      now: args.now,
      attachments: [],
    });
    return { chatRowId: chat.id, sessionId: liveSession.id, nodeId, mode };
  }

  const sessionId = crypto.randomUUID();
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
