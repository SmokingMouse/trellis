import "server-only";
import type { LarkChatType } from "@/lib/lark-types";
import type { FeishuCardV2 } from "./card";
import { createLarkClient, sendLarkText, type LarkSdkClient } from "./sdk";
import {
  getLarkBotMember,
  getLarkBotMemberByCode,
  getLarkBotMemberById,
  getLarkBotRecord,
  listLarkBotAdmins,
  listLarkBotMembers,
  setMemberDecision,
  takeMemberPendingMessage,
  type LarkBotMemberRecord,
} from "./store";

export const REPLAY_EXPIRY_MS = 24 * 3600 * 1000; // 24 小时

export type AdminCommand =
  | { type: "approve"; code: string }
  | { type: "deny"; code: string }
  | { type: "list" };

/** 纯逻辑：解析私聊文本命令（同意 <code> / 拒绝 <code> / 名单） */
export function parseAdminCommand(text: string): AdminCommand | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const approveMatch = trimmed.match(/^(?:同意|通过|approve)\s+([a-zA-Z0-9]{4,8})$/i);
  if (approveMatch) {
    return { type: "approve", code: approveMatch[1].toLowerCase() };
  }

  const denyMatch = trimmed.match(/^(?:拒绝|驳回|deny|reject)\s+([a-zA-Z0-9]{4,8})$/i);
  if (denyMatch) {
    return { type: "deny", code: denyMatch[1].toLowerCase() };
  }

  if (/^(?:名单|成员|成员列表|list)$/i.test(trimmed)) {
    return { type: "list" };
  }

  return null;
}

/** 纯逻辑：判断挂起消息是否超过 24 小时重放时效 */
export function isMessageExpiredForReplay(appliedAt: number, now = Date.now()): boolean {
  return now - appliedAt > REPLAY_EXPIRY_MS;
}

/** 纯逻辑：检查是否为有效的管理员 */
export function isLarkBotAdmin(botId: string, openId: string): boolean {
  const member = getLarkBotMember(botId, openId);
  return !!(member && member.role === "admin" && member.status === "approved");
}

/** 生成发给管理员的 Schema 2.0 审批卡片 */
export function buildApprovalCard(args: {
  botId: string;
  code: string;
  openId: string;
  source: string;
  preview: string;
}): FeishuCardV2 {
  const previewText = args.preview.trim() || "（空）";
  return {
    schema: "2.0",
    config: {
      update_multi: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: "🤖 Bot 对话权限审批申请",
      },
      template: "blue",
    },
    body: {
      direction: "vertical",
      vertical_spacing: "medium",
      elements: [
        {
          tag: "markdown",
          content:
            `**申请人**：<at id="${args.openId}"></at>\n` +
            `**来源**：${args.source}\n` +
            `**申请消息**：\n> ${previewText}\n\n` +
            `---\n💡 **文字命令兜底**：私聊回复 \`同意 ${args.code}\` 或 \`拒绝 ${args.code}\``,
        },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "同意" },
              type: "primary",
              value: {
                action: "approve",
                botId: args.botId,
                code: args.code,
                openId: args.openId,
              },
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "拒绝" },
              type: "danger",
              value: {
                action: "deny",
                botId: args.botId,
                code: args.code,
                openId: args.openId,
              },
            },
          ],
        },
      ],
    },
  };
}

/** 生成审批完成后的更新卡片 */
export function buildDecisionCard(args: {
  openId: string;
  status: "approved" | "denied";
  operatorOpenId?: string | null;
  preview?: string | null;
}): FeishuCardV2 {
  const isApproved = args.status === "approved";
  const statusText = isApproved ? "✅ 已同意" : "❌ 已拒绝";
  const opText = args.operatorOpenId ? `（操作人：<at id="${args.operatorOpenId}"></at>）` : "";
  const previewSection = args.preview ? `\n**申请消息**：\n> ${args.preview.trim()}` : "";

  return {
    schema: "2.0",
    config: {
      update_multi: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: `🤖 Bot 对话权限申请（${isApproved ? "已同意" : "已拒绝"}）`,
      },
      template: isApproved ? "green" : "grey",
    },
    body: {
      direction: "vertical",
      vertical_spacing: "medium",
      elements: [
        {
          tag: "markdown",
          content: `**申请人**：<at id="${args.openId}"></at>\n**审批结果**：${statusText}${opText}${previewSection}`,
        },
      ],
    },
  };
}

export type ReplayHandler = (botId: string, client: LarkSdkClient, queued: any) => boolean;

let _globalReplayHandler: ReplayHandler | null = null;
export function setGlobalReplayHandler(fn: ReplayHandler): void {
  _globalReplayHandler = fn;
}

/** 挂起消息是入队所需字段的 JSON；坏数据当没有，不让一条脏行卡住审批。 */
function parsePendingMessage(raw: string | null | undefined): any {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 统一审批服务函数（共三条入口共用：卡片按钮、私聊文字命令、设置页）
 */
export async function decideMember(args: {
  botId: string;
  openIdOrCode: { openId?: string; code?: string; id?: string };
  decision: "approved" | "denied";
  decidedBy: string;
  client?: LarkSdkClient;
  now?: number;
}): Promise<{
  ok: boolean;
  member?: LarkBotMemberRecord;
  message: string;
  replayed?: boolean;
}> {
  const now = args.now ?? Date.now();
  const bot = getLarkBotRecord(args.botId);
  if (!bot) {
    return { ok: false, message: `未找到机器人 ${args.botId}` };
  }

  let member: LarkBotMemberRecord | null = null;
  if (args.openIdOrCode.id) {
    member = getLarkBotMemberById(args.openIdOrCode.id);
  } else if (args.openIdOrCode.openId) {
    member = getLarkBotMember(args.botId, args.openIdOrCode.openId);
  } else if (args.openIdOrCode.code) {
    member = getLarkBotMemberByCode(args.botId, args.openIdOrCode.code);
  }

  if (!member) {
    return { ok: false, message: "未找到待审批成员" };
  }

  const client = args.client ?? createLarkClient(bot.appId, bot.appSecret);

  if (args.decision === "approved") {
    setMemberDecision({
      botId: args.botId,
      openId: member.openId,
      status: "approved",
      decidedBy: args.decidedBy,
      now,
    });

    // 先原子领取挂起消息、再做任何 await：并发的第二次批准（重复点按钮 / 卡片 + 设置页各点
    // 一次）领到 null，不会重复回复、也不会把同一条消息重放两遍（review-access F1）。
    const claimed = takeMemberPendingMessage(args.botId, member.openId, now);
    const pendingMsg = parsePendingMessage(claimed?.pendingMessage);
    let replayed = false;

    if (claimed && pendingMsg?.messageId) {
      const expired = isMessageExpiredForReplay(claimed.appliedAt, now);
      const chatId = claimed.pendingChatId || pendingMsg.chatId;

      if (!expired) {
        // 回复申请人提示已同意
        try {
          await sendLarkText({
            client,
            chatId,
            replyToMessageId: pendingMsg.messageId,
            markdown: "✅ 管理员已同意，正在处理你的消息",
          });
        } catch (err) {
          console.warn("[lark-access] 回复申请人通过提示失败", err);
        }

        // 重新入队重放
        if (_globalReplayHandler) {
          try {
            _globalReplayHandler(args.botId, client, pendingMsg);
            replayed = true;
          } catch (err) {
            console.error("[lark-access] 重放挂起消息失败", err);
          }
        }
      } else {
        // 超过 24h，只提示重新发送
        try {
          await sendLarkText({
            client,
            chatId,
            replyToMessageId: pendingMsg.messageId,
            markdown: "✅ 管理员已同意。该消息已超过 24 小时，请重新发送。",
          });
        } catch (err) {
          console.warn("[lark-access] 回复申请人超时提示失败", err);
        }
      }
    }

    const updated = getLarkBotMember(args.botId, member.openId)!;
    return {
      ok: true,
      member: updated,
      message: replayed ? "已同意申请，消息已自动重放处理" : "已同意申请",
      replayed,
    };
  }

  if (args.decision === "denied") {
    setMemberDecision({
      botId: args.botId,
      openId: member.openId,
      status: "denied",
      decidedBy: args.decidedBy,
      now,
    });

    // 同上：领到挂起消息的那一次才通知，并发拒绝不重复发「未通过」
    const claimed = takeMemberPendingMessage(args.botId, member.openId, now);
    const pendingMsg = parsePendingMessage(claimed?.pendingMessage);

    if (claimed && pendingMsg?.messageId) {
      const chatId = claimed.pendingChatId || pendingMsg.chatId;
      try {
        await sendLarkText({
          client,
          chatId,
          replyToMessageId: pendingMsg.messageId,
          markdown: "管理员未通过你的申请",
        });
      } catch (err) {
        console.warn("[lark-access] 通知申请人拒绝失败", err);
      }
    }

    const updated = getLarkBotMember(args.botId, member.openId)!;
    return {
      ok: true,
      member: updated,
      message: "已拒绝申请",
      replayed: false,
    };
  }

  return { ok: false, message: "未知决策类型" };
}

/** 处理管理员私聊发来的文字命令 */
export async function handleAdminCommand(args: {
  botId: string;
  adminOpenId: string;
  chatId: string;
  messageId: string;
  command: AdminCommand;
  client: LarkSdkClient;
}): Promise<void> {
  const { botId, adminOpenId, chatId, messageId, command, client } = args;

  if (command.type === "approve" || command.type === "deny") {
    const res = await decideMember({
      botId,
      openIdOrCode: { code: command.code },
      decision: command.type === "approve" ? "approved" : "denied",
      decidedBy: adminOpenId,
      client,
    });

    const replyText = res.ok
      ? (command.type === "approve" ? `✅ ${res.message}` : `❌ ${res.message}`)
      : `⚠️ 操作失败：${res.message}`;

    await sendLarkText({
      client,
      chatId,
      replyToMessageId: messageId,
      markdown: replyText,
    });
    return;
  }

  if (command.type === "list") {
    const members = listLarkBotMembers(botId);
    const pending = members.filter((m) => m.status === "pending");
    const admins = members.filter((m) => m.role === "admin" && m.status === "approved");
    const approvedMembers = members.filter((m) => m.role === "member" && m.status === "approved");

    const lines: string[] = ["📋 **成员与权限名单**\n"];

    lines.push(`**待审批 (${pending.length})**：`);
    if (pending.length === 0) {
      lines.push("（无待审批）\n");
    } else {
      for (const m of pending) {
        const preview = m.pendingPreview ? ` - "${m.pendingPreview.slice(0, 30)}"` : "";
        lines.push(`- 短码 \`${m.code}\`：<at id="${m.openId}"></at>${preview}`);
      }
      lines.push("");
    }

    lines.push(`**管理员 (${admins.length})**：`);
    if (admins.length === 0) {
      lines.push("（暂无管理员）\n");
    } else {
      for (const m of admins) {
        lines.push(`- <at id="${m.openId}"></at>`);
      }
      lines.push("");
    }

    lines.push(`**已放行成员 (${approvedMembers.length})**：`);
    if (approvedMembers.length === 0) {
      lines.push("（无已放行成员）\n");
    } else {
      for (const m of approvedMembers.slice(0, 20)) {
        lines.push(`- <at id="${m.openId}"></at>`);
      }
      if (approvedMembers.length > 20) {
        lines.push(`…等共 ${approvedMembers.length} 人`);
      }
    }

    await sendLarkText({
      client,
      chatId,
      replyToMessageId: messageId,
      markdown: lines.join("\n"),
    });
  }
}

/** 发送审批卡片给所有管理员 */
export async function notifyAdminsForApproval(args: {
  botId: string;
  client: LarkSdkClient;
  senderOpenId: string;
  code: string;
  source: string;
  preview: string;
}): Promise<void> {
  const admins = listLarkBotAdmins(args.botId);
  if (admins.length === 0) {
    console.info(`[lark-access] bot ${args.botId} 无已配置管理员，申请已落库（设置页可见）`);
    return;
  }

  const card = buildApprovalCard({
    botId: args.botId,
    code: args.code,
    openId: args.senderOpenId,
    source: args.source,
    preview: args.preview,
  });

  const cardContent = JSON.stringify(card);

  for (const admin of admins) {
    try {
      const response = await args.client.im.v1.message.create({
        params: { receive_id_type: "open_id" },
        data: {
          receive_id: admin.openId,
          msg_type: "interactive",
          content: cardContent,
        },
      });
      if (response && typeof (response as any).code === "number" && (response as any).code !== 0) {
        console.warn(`[lark-access] 向管理员 ${admin.openId} 发送审批卡片失败: ${(response as any).msg}`);
      }
    } catch (err) {
      console.warn(`[lark-access] 向管理员 ${admin.openId} 发送审批卡片异常`, err);
    }
  }
}

/** 处理卡片按钮点击回调（WS card.action.trigger） */
export async function handleCardActionTrigger(
  botId: string,
  client: LarkSdkClient,
  raw: any,
): Promise<{
  toast?: { type: "info" | "success" | "error" | "warning"; content: string };
  card?: FeishuCardV2;
}> {
  const operatorOpenId = raw?.operator?.open_id ?? raw?.event?.operator?.open_id;
  const actionValue = raw?.action?.value ?? raw?.event?.action?.value;

  if (!operatorOpenId) {
    return { toast: { type: "error", content: "无法获取操作人身份" } };
  }

  // 校验操作者是否为 admin
  if (!isLarkBotAdmin(botId, operatorOpenId)) {
    return { toast: { type: "error", content: "无权限操作：仅管理员可审批" } };
  }

  let parsedAction: { action?: string; botId?: string; code?: string; openId?: string } | null = null;
  if (typeof actionValue === "object" && actionValue !== null) {
    parsedAction = actionValue;
  } else if (typeof actionValue === "string") {
    try {
      parsedAction = JSON.parse(actionValue);
    } catch {
      parsedAction = null;
    }
  }

  if (!parsedAction || !parsedAction.action) {
    return { toast: { type: "error", content: "无法识别的操作指令" } };
  }

  const decision = parsedAction.action === "approve" ? "approved" : parsedAction.action === "deny" ? "denied" : null;
  if (!decision) {
    return { toast: { type: "error", content: `未知操作：${parsedAction.action}` } };
  }

  const targetOpenId = parsedAction.openId;
  const targetCode = parsedAction.code;

  const targetMember = targetOpenId
    ? getLarkBotMember(botId, targetOpenId)
    : targetCode
      ? getLarkBotMemberByCode(botId, targetCode)
      : null;

  const preview = targetMember?.pendingPreview ?? null;

  const res = await decideMember({
    botId,
    openIdOrCode: { openId: targetOpenId, code: targetCode },
    decision,
    decidedBy: operatorOpenId,
    client,
  });

  if (!res.ok) {
    return { toast: { type: "error", content: `审批失败：${res.message}` } };
  }

  const updatedCard = buildDecisionCard({
    openId: targetOpenId || targetMember?.openId || "用户",
    status: decision,
    operatorOpenId,
    preview,
  });

  return {
    toast: {
      type: "success",
      content: decision === "approved" ? (res.replayed ? "已同意并重放消息" : "已同意") : "已拒绝",
    },
    card: updatedCard,
  };
}
