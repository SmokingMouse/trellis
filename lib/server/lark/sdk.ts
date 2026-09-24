import "server-only";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as lark from "@larksuiteoapi/node-sdk";
import { buildLarkCard } from "./card";
import { cardAtToTextAt, markdownToLarkText } from "./protocol";

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

function formatErrorBrief(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  const obj = error as { code?: number; msg?: string } | null;
  if (obj && typeof obj.code === "number") {
    return `code=${obj.code} msg=${obj.msg || "unknown"}`;
  }
  return String(error);
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
  status?: "done" | "warning" | "error" | "running";
  summary?: string;
  workspacePath?: string;
  textFallback?: string;
};

type SentData = { message_id?: string; thread_id?: string } | undefined;

function sentFrom(response: unknown): LarkSentMessage {
  const data = (response as { data?: SentData } | null)?.data;
  return { messageId: data?.message_id ?? null, threadId: data?.thread_id ?? null };
}

export function isPrivateOrLoopbackHost(host: string): boolean {
  const hostname = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname) return true;
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return true;
  }

  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [_, b0, b1, b2, b3] = ipv4Match.map(Number);
    if (b0 > 255 || b1 > 255 || b2 > 255 || b3 > 255) return true;
    if (b0 === 0) return true; // 0.0.0.0/8
    if (b0 === 127) return true; // 127.0.0.0/8
    if (b0 === 10) return true; // 10.0.0.0/8
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true; // 172.16.0.0/12
    if (b0 === 192 && b1 === 168) return true; // 192.168.0.0/16
    if (b0 === 169 && b1 === 254) return true; // 169.254.0.0/16
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return true; // 100.64.0.0/10 (CGNAT)
    return false;
  }

  if (hostname === "::1" || hostname === "::") return true;
  if (
    hostname.startsWith("fe80:") ||
    hostname.startsWith("fe9") ||
    hostname.startsWith("fea") ||
    hostname.startsWith("feb")
  ) {
    return true;
  }
  if (hostname.startsWith("fc") || hostname.startsWith("fd")) return true;
  if (hostname.startsWith("::ffff:")) {
    const v4 = hostname.slice(7);
    return isPrivateOrLoopbackHost(v4);
  }

  return false;
}

export interface UploadLarkImageOptions {
  client: LarkSdkClient;
  image: Buffer | string;
  workspacePath?: string;
}

/**
 * M3 & m6: 上传图片到飞书开放平台获取 image_key（image_type=message）。
 * 仅单一对象入参签名。
 * 安全策略：
 * - 只接受 https:// URL，超时 5000ms，Content-Type 须为 image/，大小 ≤10MB
 * - 拦截私网 / 环回 / link-local 地址（SSRF 防御）
 * - 本机路径只允许在 ~/.trellis/ 或当前 workspacePath 下读取，其余不读盘
 * - 失败或不合规时返回空字符串，触发上层降级为 [图片] alt 文本
 */
export async function uploadLarkImage(options: UploadLarkImageOptions): Promise<string> {
  const { client, image, workspacePath } = options;
  const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

  let buffer: Buffer;

  if (Buffer.isBuffer(image)) {
    if (image.length > MAX_IMAGE_SIZE) {
      console.warn("[lark] 图片大小超出 10MB 限制");
      return "";
    }
    buffer = image;
  } else if (typeof image === "string") {
    const src = image.trim();
    if (src.startsWith("img_")) {
      return src;
    }

    // scheme 判断不分大小写：`HTTPS://…` 是合规 URL，落到本机路径分支会被白名单无声拒掉（复审 n5）。
    const scheme = src.toLowerCase();
    if (scheme.startsWith("http://")) {
      console.warn("[lark] 拒绝上传明文 http 图片:", src);
      return "";
    }

    if (scheme.startsWith("https://")) {
      let parsed: URL;
      try {
        parsed = new URL(src);
      } catch {
        console.warn("[lark] 无效的图片 URL:", src);
        return "";
      }

      if (isPrivateOrLoopbackHost(parsed.hostname)) {
        console.warn("[lark] 拒绝访问私网/环回地址:", parsed.hostname);
        return "";
      }

      try {
        const res = await fetch(src, {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
          console.warn(`[lark] 下载图片失败 (${res.status} ${res.statusText}): ${src}`);
          return "";
        }

        const contentType = res.headers.get("content-type") || "";
        if (!contentType.toLowerCase().startsWith("image/")) {
          console.warn(`[lark] 响应不是图片类型 (${contentType}): ${src}`);
          return "";
        }

        const contentLength = res.headers.get("content-length");
        if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_SIZE) {
          console.warn(`[lark] 图片 Content-Length 超出 10MB: ${src}`);
          return "";
        }

        const arrayBuffer = await res.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_IMAGE_SIZE) {
          console.warn(`[lark] 图片大小超出 10MB: ${src}`);
          return "";
        }
        buffer = Buffer.from(arrayBuffer);
      } catch (fetchError) {
        const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
        console.warn(`[lark] 获取图片网络异常 (${msg}): ${src}`);
        return "";
      }
    } else {
      // 本机路径安全校验
      const rawPath = scheme.startsWith("file://") ? new URL(src).pathname : src;
      // 先解 symlink 再比对白名单：workspace 里一个指向外部的软链接不能把任意文件带出去
      // （复审 n1 实测能读到白名单外的 secret）。realpath 失败（不存在 / 无权限）直接拒。
      let resolvedPath: string;
      try {
        resolvedPath = await fsPromises.realpath(path.resolve(rawPath));
      } catch (realpathError) {
        const msg = realpathError instanceof Error ? realpathError.message : String(realpathError);
        console.warn(`[lark] 本机图片路径无法解析 (${msg}): ${rawPath}`);
        return "";
      }
      const realRoot = async (p: string): Promise<string> => {
        try {
          return await fsPromises.realpath(p);
        } catch {
          return path.resolve(p);
        }
      };
      const allowedRoots: string[] = [await realRoot(path.resolve(os.homedir(), ".trellis"))];
      if (workspacePath) {
        allowedRoots.push(await realRoot(path.resolve(workspacePath)));
      }

      const isAllowed = allowedRoots.some(
        (root) => resolvedPath === root || resolvedPath.startsWith(root + path.sep),
      );

      if (!isAllowed) {
        console.warn(`[lark] 本机图片路径不在白名单目录内 (~/.trellis 或 workspace): ${resolvedPath}`);
        return "";
      }

      try {
        const stat = await fsPromises.stat(resolvedPath);
        if (stat.size > MAX_IMAGE_SIZE) {
          console.warn(`[lark] 本机图片文件超过 10MB: ${resolvedPath}`);
          return "";
        }
        buffer = await fsPromises.readFile(resolvedPath);
      } catch (readError) {
        const msg = readError instanceof Error ? readError.message : String(readError);
        console.warn(`[lark] 读取本机图片失败 (${msg}): ${resolvedPath}`);
        return "";
      }
    }
  } else {
    return "";
  }

  try {
    const uploadResult = (await client.im.v1.image.create({
      data: {
        image_type: "message",
        image: buffer,
      },
    })) as { code?: number; msg?: string; image_key?: string; data?: { image_key?: string } } | null;

    if (uploadResult && typeof uploadResult.code === "number" && uploadResult.code !== 0) {
      console.warn(`[lark] 上传飞书图片接口返回非0 (code=${uploadResult.code}, msg=${uploadResult.msg || "unknown"})`);
      return "";
    }

    const imageKey = uploadResult?.image_key ?? uploadResult?.data?.image_key;
    if (!imageKey) {
      console.warn("[lark] 飞书未返回 image_key");
      return "";
    }
    return imageKey;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[lark] 上传飞书图片异常 (${msg})`);
    return "";
  }
}

/**
 * 优先发送 Schema 2.0 互动卡片（interactive），thread 模式的 reply_in_thread 语义保持；
 * 卡片发送失败（飞书回非 0 code）降级回纯文本路径并打日志，不丢消息。
 * 优先锚定入站消息（quote / thread）；reply 不可用时才降级到 chat_id 顶层消息。
 * m2: 降级日志只输出简明摘要与错误消息，避免上游对象泄露凭证。
 */
export async function sendLarkText(args: LarkSendOptions): Promise<LarkSentMessage> {
  const mode = args.mode ?? "quote";

  // 1. 尝试卡片发送（Schema 2.0 interactive）
  try {
    const card = await buildLarkCard(args.markdown, {
      sessionUrl: args.sessionUrl,
      title: args.title,
      status: args.status,
      summary: args.summary,
      uploadImage: (src) =>
        uploadLarkImage({
          client: args.client,
          image: src,
          workspacePath: args.workspacePath,
        }),
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
        console.warn(`[lark] card reply 失败 (${formatErrorBrief(error)})，降级为 chat_id create`);
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
    console.warn(`[lark] 互动卡片发送失败 (${formatErrorBrief(cardError)})，降级为纯文本`);
  }

  // 2. 降级回纯文本（text）；卡片的 <at> 写法要换成 text 的，否则 @ 人会变成一串原文
  const content = args.textFallback
    ? JSON.stringify({ text: cardAtToTextAt(args.textFallback) })
    : markdownToLarkText(cardAtToTextAt(args.markdown));

  if (mode !== "plain" && args.replyToMessageId) {
    try {
      const response = await args.client.im.v1.message.reply({
        path: { message_id: args.replyToMessageId },
        data: { msg_type: "text", content, reply_in_thread: mode === "thread" },
      });
      assertApiSuccess("回复飞书文本消息失败", response);
      return sentFrom(response);
    } catch (error) {
      console.warn(`[lark] reply 失败 (${formatErrorBrief(error)})，降级为 chat_id create`);
    }
  }
  const response = await args.client.im.v1.message.create({
    params: { receive_id_type: "chat_id" },
    data: { receive_id: args.chatId, msg_type: "text", content },
  });
  assertApiSuccess("发送飞书文本消息失败", response);
  return sentFrom(response);
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
