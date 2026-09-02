export type LarkTaskBindingInput = {
  larkBotId?: string | null;
  larkChatId?: string | null;
};

export type LarkTaskBinding = {
  larkBotId: string | null;
  larkChatId: string | null;
};

export type LarkTaskTargetLookup = (
  botId: string,
  chatId: string,
) => "ok" | "bot_missing" | "chat_missing";

export class LarkTaskBindingError extends Error {}

/**
 * 任务的飞书落点是一个原子二元组：PATCH 不能只改一半，空字符串与 null 都表示解绑。
 * 查库由调用方注入，方便 API/service 共用同一份校验语义，也让测试无需碰真实 DB。
 */
export function resolveLarkTaskBinding(
  input: LarkTaskBindingInput,
  lookup: LarkTaskTargetLookup,
): LarkTaskBinding | null {
  const hasBot = input.larkBotId !== undefined;
  const hasChat = input.larkChatId !== undefined;
  if (!hasBot && !hasChat) return null;
  if (!hasBot || !hasChat) {
    throw new LarkTaskBindingError("larkBotId 与 larkChatId 必须同时提供或同时为空");
  }

  if (
    (input.larkBotId !== null && typeof input.larkBotId !== "string") ||
    (input.larkChatId !== null && typeof input.larkChatId !== "string")
  ) {
    throw new LarkTaskBindingError("larkBotId 与 larkChatId 必须是字符串或 null");
  }

  const botId = typeof input.larkBotId === "string" ? input.larkBotId.trim() : "";
  const chatId = typeof input.larkChatId === "string" ? input.larkChatId.trim() : "";
  if (!botId && !chatId) return { larkBotId: null, larkChatId: null };
  if (!botId || !chatId) {
    throw new LarkTaskBindingError("larkBotId 与 larkChatId 必须同时提供或同时为空");
  }

  const target = lookup(botId, chatId);
  if (target === "bot_missing") throw new LarkTaskBindingError("飞书机器人不存在");
  if (target === "chat_missing") {
    throw new LarkTaskBindingError("飞书 chat 不存在，或不属于所选机器人");
  }
  return { larkBotId: botId, larkChatId: chatId };
}
