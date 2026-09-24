import "server-only";
import type { lark } from "./sdk";

/**
 * Trellis 机器人标准权限、事件与回调集合（AppAddons）。
 * 扫码新建或更新 bot 时传给 registerApp，在飞书确认页列出供用户一次授权。
 */
export const TRELLIS_BOT_ADDONS: lark.AppAddons = {
  // preset 保持缺省（true/omitted），叠在平台默认模板上
  scopes: {
    tenant: [
      // 1. 收私聊消息：im.message.receive_v1 事件接收单聊 (lib/server/lark/handler.ts:49)
      "im:message.p2p_msg:readonly",
      // 2. 收群 @ 消息：im.message.receive_v1 事件接收群聊 @ 机器人 (lib/server/lark/handler.ts:49)
      "im:message.group_at_msg:readonly",
      // 3. 收群所有消息不在标准集：见 GROUP_ALL_MESSAGES_SCOPE，只给 groupTrigger≠mention 的 bot 按需申请
      // 4. 以应用身份发消息/回复/发卡片 (lib/server/lark/sdk.ts:328, sdk.ts:343, sdk.ts:364, sdk.ts:374, access.ts:460)
      "im:message:send_as_bot",
      // 5. 基础消息读写权限 (lib/server/lark/sdk.ts:305-380, push.ts:131)
      "im:message",
      // 6. 更新卡片/消息内容 (lib/server/lark/sdk.ts:308, card.ts:6)
      "im:message:update",
      // 7. 表情 ack（ackMode=reaction 为消息添加 OnIt 表情反应） (lib/server/lark/sdk.ts:57)
      "im:message.reactions:write_only",
      // 8+9. 上传卡片图片、下载消息资源 / 媒体文件 (lib/server/lark/sdk.ts:274, sdk.ts:143, handler.ts:350)
      //      飞书只有 im:resource 一个 scope（lark-cli scope_priorities.json 无 :upload / :download）
      "im:resource",
      // 10. 获取群信息（群名称解析） (lib/server/lark/sdk.ts:390)
      "im:chat:read",
      // 11. 读取消息内容 (lib/server/lark/sdk.ts:305)
      "im:message:readonly",
      // 12. 按邮箱 / 手机号解析用户 open_id（contact/v3/users/batch_get_id；任务推送 @ 具体同学时要用）
      "contact:user.id:readonly",
    ],
  },
  events: {
    items: {
      tenant: [
        // 接收消息事件 (lib/server/lark/manager.ts:48, handler.ts:49)
        "im.message.receive_v1",
      ],
    },
  },
  callbacks: {
    items: [
      // 审批卡片按钮点击回调 (lib/server/lark/manager.ts:52, access.ts:478)
      "card.action.trigger",
    ],
  },
};

/**
 * 收群里全部消息（groupTrigger=all / prefix 才需要，lib/lark-types.ts:39）。
 * 企业租户里这类权限常要管理员审批，放进标准集会让扫码新建卡在审批上，所以只在 update 时按需加。
 */
export const GROUP_ALL_MESSAGES_SCOPE = "im:message.group_msg";
