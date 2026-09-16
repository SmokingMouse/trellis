import "server-only";
import * as fsPromises from "node:fs/promises";
import * as lark from "@larksuiteoapi/node-sdk";
import { buildLarkCard } from "./card";
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

/** quote = 引用回复；thread = 话题回复（reply_in_thread）；plain = 平铺发到 chat。 */
export type LarkSendMode = "quote" | "thread" | "plain";

/** 发出去的那条消息的身份 —— outbox 靠 messageId 把「引用机器人回答」映射回节点，话题靠 threadId 映射到树。 */
export type LarkSentMessage = { messageId: string | null; threadId: string | null };

export type LarkSendOptions = {
  client: LarkSdkClient;
  chatId: string;
  replyToMessageId?: string | null;
  markdown: string;
  mode?: LarkSendMode;
  sessionUrl?: string;
  title?: string;
};

type SentData = { message_id?: string; thread_id?: string } | undefined;

function sentFrom(response: unknown): LarkSentMessage {
  const data = (response as { data?: SentData } | null)?.data;
  return { messageId: data?.message_id ?? null, threadId: data?.thread_id ?? null };
}

/**
 * 上传图片到飞书开放平台获取 image_key（image_type=message）。
 * image 参数支持 Buffer、本机绝对文件路径（或 file://）以及 http(s) URL。
 */
export async function uploadLarkImage(
  argsOrClient: LarkSdkClient | { client: LarkSdkClient; image: Buffer | string },
  maybeImage?: Buffer | string,
): Promise<string> {
  let client: LarkSdkClient;
  let image: Buffer | string;
  if (typeof argsOrClient === "object" && "client" in argsOrClient && "image" in argsOrClient) {
    client = argsOrClient.client;
    image = argsOrClient.image;
  } else {
    client = argsOrClient as LarkSdkClient;
    image = maybeImage!;
  }

  let buffer: Buffer;
  if (Buffer.isBuffer(image)) {
    buffer = image;
  } else if (typeof image === "string") {
    const src = image.trim();
    if (src.startsWith("http://") || src.startsWith("https://")) {
      const res = await fetch(src);
      if (!res.ok) {
        throw new Error(`下载图片失败 (${res.status} ${res.statusText}): ${src}`);
      }
      const arrayBuffer = await res.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
    } else {
      const filePath = src.startsWith("file://") ? new URL(src).pathname : src;
      buffer = await fsPromises.readFile(filePath);
    }
  } else {
    throw new Error("无效的图片参数");
  }

  const uploadResult = (await client.im.v1.image.create({
    data: {
      image_type: "message",
      image: buffer,
    },
  })) as { code?: number; msg?: string; image_key?: string; data?: { image_key?: string } } | null;

  if (uploadResult && typeof uploadResult.code === "number" && uploadResult.code !== 0) {
    throw new Error(`上传飞书图片失败 (code=${uploadResult.code}, msg=${uploadResult.msg || "unknown"})`);
  }

  const imageKey = uploadResult?.image_key ?? uploadResult?.data?.image_key;
  if (!imageKey) {
    throw new Error("飞书未返回 image_key");
  }
  return imageKey;
}

/**
 * 优先发送 Schema 2.0 互动卡片（interactive），thread 模式的 reply_in_thread 语义保持；
 * 卡片发送失败（飞书回非 0 code）降级回现有 markdownToLarkText 的纯文本路径并打日志，不丢消息。
 * 优先锚定入站消息（quote / thread）；reply 不可用时才降级到 chat_id 顶层消息。
 */
export async function sendLarkText(args: LarkSendOptions): Promise<LarkSentMessage> {
  const mode = args.mode ?? "quote";

  // 1. 尝试卡片发送（Schema 2.0 interactive）
  try {
    const card = await buildLarkCard(args.markdown, {
      sessionUrl: args.sessionUrl,
      title: args.title,
      uploadImage: (src) => uploadLarkImage({ client: args.client, image: src }),
    });
    const interactiveContent = JSON.stringify(card);

    if (mode !== "plain" && args.replyToMessageId) {
      try {
        const response = await args.client.im.v1.message.reply({
          path: { message_id: args.replyToMessageId },
          data: {
            msg_type: "interactive",
            content: interactiveContent,
            reply_in_thread: mode === "thread",
          },
        });
        assertApiSuccess("回复飞书卡片消息失败", response);
        return sentFrom(response);
      } catch (error) {
        console.warn("[lark] card reply 失败，降级为 chat_id create", error);
      }
    }

    const response = await args.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: args.chatId,
        msg_type: "interactive",
        content: interactiveContent,
      },
    });
    assertApiSuccess("发送飞书卡片消息失败", response);
    return sentFrom(response);
  } catch (cardError) {
    console.warn("[lark] 互动卡片发送失败，降级为纯文本:", cardError);
  }

  // 2. 降级回纯文本（text）
  const content = markdownToLarkText(args.markdown);
  if (mode !== "plain" && args.replyToMessageId) {
    try {
      const response = await args.client.im.v1.message.reply({
        path: { message_id: args.replyToMessageId },
        data: { msg_type: "text", content, reply_in_thread: mode === "thread" },
      });
      assertApiSuccess("回复飞书文本消息失败", response);
      return sentFrom(response);
    } catch (error) {
      console.warn("[lark] reply 失败，降级为 chat_id create", error);
    }
  }
  const response = await args.client.im.v1.message.create({
    params: { receive_id_type: "chat_id" },
    data: { receive_id: args.chatId, msg_type: "text", content },
  });
  assertApiSuccess("发送飞书文本消息失败", response);
  return sentFrom(response);
}

export const sendLarkCard = sendLarkText;

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
