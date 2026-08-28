import "server-only";
import * as lark from "@larksuiteoapi/node-sdk";
import { markdownToLarkText } from "./protocol";

export type LarkSdkClient = lark.Client;
export type LarkBotInfo = { openId: string; name: string };

export function createLarkClient(appId: string, appSecret: string): LarkSdkClient {
  return new lark.Client({
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    loggerLevel: lark.LoggerLevel.warn,
  });
}

function assertApiSuccess(label: string, response: unknown): void {
  const result = response as { code?: number; msg?: string } | null;
  if (result && typeof result.code === "number" && result.code !== 0) {
    throw new Error(`${label}: ${result.msg || `code ${result.code}`}`);
  }
}

/** 这个接口同时完成 tenant_access_token 换取与 bot 身份探测。 */
export async function fetchLarkBotInfo(client: LarkSdkClient): Promise<LarkBotInfo> {
  const response = await client.request({ method: "GET", url: "/open-apis/bot/v3/info/" });
  assertApiSuccess("获取飞书机器人信息失败", response);
  const result = response as {
    bot?: { open_id?: string; app_name?: string };
    data?: { bot?: { open_id?: string; app_name?: string } };
  };
  const bot = result.bot ?? result.data?.bot;
  if (!bot?.open_id) throw new Error("飞书未返回 bot open_id，请确认应用已开启机器人能力");
  return { openId: bot.open_id, name: bot.app_name?.trim() || "飞书机器人" };
}

export async function testLarkCredentials(appId: string, appSecret: string): Promise<LarkBotInfo> {
  return fetchLarkBotInfo(createLarkClient(appId, appSecret));
}

export async function addLarkAck(client: LarkSdkClient, messageId: string): Promise<void> {
  const response = await client.im.v1.messageReaction.create({
    path: { message_id: messageId },
    data: { reaction_type: { emoji_type: "OnIt" } },
  });
  assertApiSuccess("添加飞书确认表情失败", response);
}

/** 优先锚定入站消息；reply 不可用时才降级到 chat_id 顶层消息。 */
export async function sendLarkText(args: {
  client: LarkSdkClient;
  chatId: string;
  replyToMessageId?: string | null;
  markdown: string;
}): Promise<void> {
  const content = markdownToLarkText(args.markdown);
  if (args.replyToMessageId) {
    try {
      const response = await args.client.im.v1.message.reply({
        path: { message_id: args.replyToMessageId },
        data: { msg_type: "text", content },
      });
      assertApiSuccess("回复飞书消息失败", response);
      return;
    } catch (error) {
      console.warn("[lark] reply 失败，降级为 chat_id create", error);
    }
  }
  const response = await args.client.im.v1.message.create({
    params: { receive_id_type: "chat_id" },
    data: { receive_id: args.chatId, msg_type: "text", content },
  });
  assertApiSuccess("发送飞书消息失败", response);
}

export async function resolveLarkChatTitle(
  client: LarkSdkClient,
  chatId: string,
  chatType: "p2p" | "group",
  senderOpenId: string | null,
): Promise<string> {
  if (chatType === "group") {
    try {
      const response = await client.im.v1.chat.get({ path: { chat_id: chatId } });
      assertApiSuccess("获取群信息失败", response);
      if (response.data?.name?.trim()) return response.data.name.trim();
    } catch {
      // 标题是展示增强，不该阻断消息主链。
    }
    return `飞书群 ${chatId.slice(-6)}`;
  }
  return `飞书私聊 ${(senderOpenId || chatId).slice(-6)}`;
}

export { lark };
