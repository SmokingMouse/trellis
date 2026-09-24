import { describe, expect, test, mock, beforeEach, afterAll } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

mock.module("server-only", () => ({}));

// 隔离临时测试数据库
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-lark-access-test-"));
process.env.TRELLIS_DB_PATH = path.join(testHome, "test.db");

const { getDB, resetDBForTests } = await import("@/lib/server/sqlite");
const {
  createLarkBot,
  getLarkBot,
  getLarkBotRecord,
  getLarkBotMember,
  getLarkBotMemberByCode,
  listLarkBotMembers,
  listLarkBotAdmins,
  preapproveMember,
  updateMemberRole,
  deleteLarkBotMember,
  upsertPendingMember,
  generateMemberCode,
} = await import("./store");
const {
  parseAdminCommand,
  isMessageExpiredForReplay,
  isLarkBotAdmin,
  buildApprovalCard,
  buildDecisionCard,
  decideMember,
  handleCardActionTrigger,
  handleAdminCommand,
  setGlobalReplayHandler,
  REPLAY_EXPIRY_MS,
} = await import("./access");

describe("Lark Access Control (fj-access)", () => {
  beforeEach(() => {
    // 每次测试前复位 DB
    const db = getDB();
    db.exec("DELETE FROM lark_bot_members");
    db.exec("DELETE FROM lark_bots");
  });

  afterAll(() => {
    resetDBForTests();
    try {
      fs.rmSync(testHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("1. 纯逻辑：管理员文字命令解析", () => {
    test("解析同意命令：同意 / 通过 / approve + 4~8位短码", () => {
      expect(parseAdminCommand("同意 7a2f")).toEqual({ type: "approve", code: "7a2f" });
      expect(parseAdminCommand("通过 A1B2")).toEqual({ type: "approve", code: "a1b2" });
      expect(parseAdminCommand("approve 1234")).toEqual({ type: "approve", code: "1234" });
      expect(parseAdminCommand("  同意   9f8e  ")).toEqual({ type: "approve", code: "9f8e" });
    });

    test("解析拒绝命令：拒绝 / 驳回 / deny / reject + 4~8位短码", () => {
      expect(parseAdminCommand("拒绝 7a2f")).toEqual({ type: "deny", code: "7a2f" });
      expect(parseAdminCommand("驳回 A1B2")).toEqual({ type: "deny", code: "a1b2" });
      expect(parseAdminCommand("deny 1234")).toEqual({ type: "deny", code: "1234" });
      expect(parseAdminCommand("reject c3d4")).toEqual({ type: "deny", code: "c3d4" });
    });

    test("解析名单命令：名单 / 成员 / 成员列表 / list", () => {
      expect(parseAdminCommand("名单")).toEqual({ type: "list" });
      expect(parseAdminCommand("成员")).toEqual({ type: "list" });
      expect(parseAdminCommand("成员列表")).toEqual({ type: "list" });
      expect(parseAdminCommand("list")).toEqual({ type: "list" });
      expect(parseAdminCommand("  名单  ")).toEqual({ type: "list" });
    });

    test("普通文本不被误判为命令", () => {
      expect(parseAdminCommand("你好机器人")).toBeNull();
      expect(parseAdminCommand("同意")).toBeNull();
      expect(parseAdminCommand("拒绝")).toBeNull();
      expect(parseAdminCommand("同意 12")).toBeNull(); // 短码太短
      expect(parseAdminCommand("我有不同意见")).toBeNull();
      expect(parseAdminCommand("")).toBeNull();
    });
  });

  describe("2. 纯逻辑：重放时效判断", () => {
    test("24小时内未过期", () => {
      const now = 1700000000000;
      expect(isMessageExpiredForReplay(now - 1000, now)).toBe(false);
      expect(isMessageExpiredForReplay(now - 23 * 3600 * 1000, now)).toBe(false);
      expect(isMessageExpiredForReplay(now - REPLAY_EXPIRY_MS, now)).toBe(false);
    });

    test("超过24小时已过期", () => {
      const now = 1700000000000;
      expect(isMessageExpiredForReplay(now - (REPLAY_EXPIRY_MS + 1), now)).toBe(true);
      expect(isMessageExpiredForReplay(now - 48 * 3600 * 1000, now)).toBe(true);
    });
  });

  describe("3. 纯逻辑：卡片结构构建", () => {
    test("buildApprovalCard 生成符合 Schema 2.0 的审批卡片", () => {
      const card = buildApprovalCard({
        botId: "bot_1",
        code: "7a2f",
        openId: "ou_applicant_1",
        source: "sub2api 测试群",
        preview: "帮我查询号池状态",
      });

      expect(card.schema).toBe("2.0");
      expect(card.header?.title.content).toContain("审批");
      expect(card.header?.template).toBe("blue");

      const elements = card.body.elements;
      expect(elements.length).toBe(2);

      // Markdown 提示区
      const md = elements[0];
      expect(md.tag).toBe("markdown");
      expect(String(md.content)).toContain('<at id="ou_applicant_1"></at>');
      expect(String(md.content)).toContain("sub2api 测试群");
      expect(String(md.content)).toContain("帮我查询号池状态");
      expect(String(md.content)).toContain("同意 7a2f");

      // 按钮操作区
      const action = elements[1];
      expect(action.tag).toBe("action");
      const buttons = action.actions as any[];
      expect(buttons.length).toBe(2);
      expect(buttons[0].text.content).toBe("同意");
      expect(buttons[0].value.action).toBe("approve");
      expect(buttons[0].value.code).toBe("7a2f");
      expect(buttons[1].text.content).toBe("拒绝");
      expect(buttons[1].value.action).toBe("deny");
    });

    test("buildDecisionCard 生成审批完成卡片", () => {
      const card = buildDecisionCard({
        openId: "ou_applicant_1",
        status: "approved",
        operatorOpenId: "ou_admin_1",
        preview: "帮我查询号池状态",
      });

      expect(card.schema).toBe("2.0");
      expect(card.header?.title.content).toContain("已同意");
      expect(card.header?.template).toBe("green");

      const md = card.body.elements[0];
      expect(String(md.content)).toContain('<at id="ou_applicant_1"></at>');
      expect(String(md.content)).toContain("已同意");
      expect(String(md.content)).toContain('<at id="ou_admin_1"></at>');
      expect(String(md.content)).toContain("帮我查询号池状态");
    });
  });

  describe("4. 数据库与成员 Store 管理", () => {
    test("bot accessMode 默认 open，可配置为 approval", () => {
      const bot = createLarkBot({
        name: "测试 Bot",
        appId: "cli_test_bot_1",
        appSecret: "sec_1",
      });
      expect(bot.accessMode).toBe("open");

      const record = getLarkBotRecord(bot.id);
      expect(record?.accessMode).toBe("open");

      const { updateLarkBot } = require("./store");
      const updated = updateLarkBot(bot.id, { accessMode: "approval" });
      expect(updated?.accessMode).toBe("approval");
    });

    test("生成 4 位短码唯一性", () => {
      const bot = createLarkBot({
        name: "测试 Bot 2",
        appId: "cli_test_bot_2",
        appSecret: "sec_2",
      });
      const code1 = generateMemberCode(bot.id);
      expect(code1.length).toBe(4);
      const code2 = generateMemberCode(bot.id);
      expect(code2.length).toBe(4);
    });

    test("upsertPendingMember 记录挂起申请并节流通知", () => {
      const bot = createLarkBot({
        name: "测试 Bot 3",
        appId: "cli_test_bot_3",
        appSecret: "sec_3",
      });

      const t0 = 1700000000000;
      const res1 = upsertPendingMember({
        botId: bot.id,
        openId: "ou_user_1",
        name: "张三",
        pendingMessage: { messageId: "msg_1", text: "第一条消息" },
        pendingPreview: "第一条消息",
        pendingChatId: "oc_chat_1",
        now: t0,
      });

      expect(res1.member.status).toBe("pending");
      expect(res1.member.role).toBe("member");
      expect(res1.member.name).toBe("张三");
      expect(res1.member.code.length).toBe(4);
      expect(res1.shouldNotifySender).toBe(true);
      expect(res1.shouldNotifyAdmin).toBe(true);

      // 5 分钟后同一人再发消息：覆盖挂起消息，但通知被节流（sender 24h，admin 1h）
      const t1 = t0 + 5 * 60 * 1000;
      const res2 = upsertPendingMember({
        botId: bot.id,
        openId: "ou_user_1",
        pendingMessage: { messageId: "msg_2", text: "第二条最新消息" },
        pendingPreview: "第二条最新消息",
        pendingChatId: "oc_chat_1",
        now: t1,
      });

      expect(res2.member.pendingPreview).toBe("第二条最新消息");
      expect(res2.shouldNotifySender).toBe(false);
      expect(res2.shouldNotifyAdmin).toBe(false);

      // 2 小时后：admin 节流解除（>1h），sender 仍在节流期（<24h）
      const t2 = t0 + 2 * 3600 * 1000;
      const res3 = upsertPendingMember({
        botId: bot.id,
        openId: "ou_user_1",
        pendingMessage: { messageId: "msg_3", text: "第三条消息" },
        pendingPreview: "第三条消息",
        pendingChatId: "oc_chat_1",
        now: t2,
      });
      expect(res3.shouldNotifySender).toBe(false);
      expect(res3.shouldNotifyAdmin).toBe(true);

      // 25 小时后：两边节流均解除
      const t3 = t0 + 25 * 3600 * 1000;
      const res4 = upsertPendingMember({
        botId: bot.id,
        openId: "ou_user_1",
        pendingMessage: { messageId: "msg_4", text: "第四条消息" },
        pendingPreview: "第四条消息",
        pendingChatId: "oc_chat_1",
        now: t3,
      });
      expect(res4.shouldNotifySender).toBe(true);
      expect(res4.shouldNotifyAdmin).toBe(true);
    });

    test("管理员定义：role=admin 且 status=approved", () => {
      const bot = createLarkBot({
        name: "测试 Bot 4",
        appId: "cli_test_bot_4",
        appSecret: "sec_4",
      });

      // 预先放行普通成员
      preapproveMember({
        botId: bot.id,
        openId: "ou_member_1",
        role: "member",
      });
      expect(isLarkBotAdmin(bot.id, "ou_member_1")).toBe(false);

      // 预先放行管理员
      preapproveMember({
        botId: bot.id,
        openId: "ou_admin_1",
        role: "admin",
      });
      expect(isLarkBotAdmin(bot.id, "ou_admin_1")).toBe(true);

      // 待审批用户即便设了 role=admin 也不算有效 admin
      const pendingAdmin = upsertPendingMember({
        botId: bot.id,
        openId: "ou_pending_admin",
        pendingMessage: {},
        pendingPreview: "申请",
        pendingChatId: "oc_1",
      });
      updateMemberRole(bot.id, "ou_pending_admin", "admin");
      expect(isLarkBotAdmin(bot.id, "ou_pending_admin")).toBe(false);

      const admins = listLarkBotAdmins(bot.id);
      expect(admins.length).toBe(1);
      expect(admins[0].openId).toBe("ou_admin_1");
    });
  });

  describe("5. 服务函数 decideMember 审批与重放闭环", () => {
    test("同意申请：24小时内自动回复并重放挂起消息", async () => {
      const bot = createLarkBot({
        name: "测试 Bot 5",
        appId: "cli_test_bot_5",
        appSecret: "sec_5",
        accessMode: "approval",
      });

      const now = 1700000000000;
      const member = upsertPendingMember({
        botId: bot.id,
        openId: "ou_applicant_1",
        pendingMessage: { messageId: "om_1001", chatId: "oc_chat_1", text: "帮我查询数据" },
        pendingPreview: "帮我查询数据",
        pendingChatId: "oc_chat_1",
        now,
      }).member;

      let replayedMessage: any = null;
      setGlobalReplayHandler((botId, client, queued) => {
        replayedMessage = queued;
        return true;
      });

      // mock client send
      const mockClient: any = {
        im: {
          v1: {
            message: {
              reply: async () => ({ code: 0, data: { message_id: "om_reply_1" } }),
              create: async () => ({ code: 0, data: { message_id: "om_create_1" } }),
            },
          },
        },
      };

      const result = await decideMember({
        botId: bot.id,
        openIdOrCode: { code: member.code },
        decision: "approved",
        decidedBy: "ou_admin_1",
        client: mockClient,
        now: now + 10 * 60 * 1000, // 10 分钟后同意
      });

      expect(result.ok).toBe(true);
      expect(result.replayed).toBe(true);

      const updated = getLarkBotMember(bot.id, "ou_applicant_1");
      expect(updated?.status).toBe("approved");
      expect(updated?.decidedBy).toBe("ou_admin_1");
      expect(updated?.pendingMessage).toBeNull(); // 已重放并清理
      expect(replayedMessage?.messageId).toBe("om_1001");
      expect(replayedMessage?.text).toBe("帮我查询数据");
    });

    test("同意申请：超过24小时只提示不重放", async () => {
      const bot = createLarkBot({
        name: "测试 Bot 6",
        appId: "cli_test_bot_6",
        appSecret: "sec_6",
        accessMode: "approval",
      });

      const now = 1700000000000;
      const member = upsertPendingMember({
        botId: bot.id,
        openId: "ou_applicant_2",
        pendingMessage: { messageId: "om_1002", chatId: "oc_chat_2", text: "老消息" },
        pendingPreview: "老消息",
        pendingChatId: "oc_chat_2",
        now,
      }).member;

      let replayedMessage: any = null;
      setGlobalReplayHandler((botId, client, queued) => {
        replayedMessage = queued;
        return true;
      });

      const mockClient: any = {
        im: {
          v1: {
            message: {
              reply: async () => ({ code: 0, data: { message_id: "om_reply_2" } }),
              create: async () => ({ code: 0, data: { message_id: "om_create_2" } }),
            },
          },
        },
      };

      const result = await decideMember({
        botId: bot.id,
        openIdOrCode: { openId: "ou_applicant_2" },
        decision: "approved",
        decidedBy: "ou_admin_1",
        client: mockClient,
        now: now + 30 * 3600 * 1000, // 30 小时后同意（已超过24h）
      });

      expect(result.ok).toBe(true);
      expect(result.replayed).toBe(false);
      expect(replayedMessage).toBeNull(); // 未重放

      const updated = getLarkBotMember(bot.id, "ou_applicant_2");
      expect(updated?.status).toBe("approved");
      expect(updated?.pendingMessage).toBeNull();
    });

    test("拒绝申请：设置为 denied 并通知申请人", async () => {
      const bot = createLarkBot({
        name: "测试 Bot 7",
        appId: "cli_test_bot_7",
        appSecret: "sec_7",
        accessMode: "approval",
      });

      const member = upsertPendingMember({
        botId: bot.id,
        openId: "ou_applicant_3",
        pendingMessage: { messageId: "om_1003", chatId: "oc_chat_3", text: "申请测试" },
        pendingPreview: "申请测试",
        pendingChatId: "oc_chat_3",
      }).member;

      const mockClient: any = {
        im: {
          v1: {
            message: {
              reply: async () => ({ code: 0, data: { message_id: "om_reply_3" } }),
              create: async () => ({ code: 0, data: { message_id: "om_create_3" } }),
            },
          },
        },
      };

      const result = await decideMember({
        botId: bot.id,
        openIdOrCode: { code: member.code },
        decision: "denied",
        decidedBy: "ou_admin_1",
        client: mockClient,
      });

      expect(result.ok).toBe(true);
      const updated = getLarkBotMember(bot.id, "ou_applicant_3");
      expect(updated?.status).toBe("denied");
      expect(updated?.decidedBy).toBe("ou_admin_1");
    });
  });

  describe("6. 卡片回调与文字命令执行", () => {
    test("handleCardActionTrigger 校验非管理员拒绝操作", async () => {
      const bot = createLarkBot({
        name: "测试 Bot 8",
        appId: "cli_test_bot_8",
        appSecret: "sec_8",
      });

      const mockClient: any = {};
      const res = await handleCardActionTrigger(bot.id, mockClient, {
        operator: { open_id: "ou_random_user" },
        action: { value: { action: "approve", code: "7a2f" } },
      });

      expect(res.toast?.type).toBe("error");
      expect(res.toast?.content).toContain("仅管理员可审批");
    });

    test("handleCardActionTrigger 管理员点击同意返回成功 toast 与更新卡片", async () => {
      const bot = createLarkBot({
        name: "测试 Bot 9",
        appId: "cli_test_bot_9",
        appSecret: "sec_9",
      });

      preapproveMember({
        botId: bot.id,
        openId: "ou_admin_9",
        role: "admin",
      });

      const member = upsertPendingMember({
        botId: bot.id,
        openId: "ou_user_9",
        pendingMessage: {},
        pendingPreview: "测试申请",
        pendingChatId: "oc_9",
      }).member;

      const mockClient: any = {
        im: {
          v1: {
            message: {
              reply: async () => ({ code: 0, data: {} }),
              create: async () => ({ code: 0, data: {} }),
            },
          },
        },
      };

      const res = await handleCardActionTrigger(bot.id, mockClient, {
        operator: { open_id: "ou_admin_9" },
        action: { value: { action: "approve", code: member.code, openId: member.openId } },
      });

      expect(res.toast?.type).toBe("success");
      expect(res.card?.schema).toBe("2.0");
      expect(res.card?.header?.title.content).toContain("已同意");
    });

    test("handleAdminCommand 私聊文字命令处理", async () => {
      const bot = createLarkBot({
        name: "测试 Bot 10",
        appId: "cli_test_bot_10",
        appSecret: "sec_10",
        accessMode: "approval",
      });

      preapproveMember({
        botId: bot.id,
        openId: "ou_admin_10",
        role: "admin",
      });

      const member = upsertPendingMember({
        botId: bot.id,
        openId: "ou_user_10",
        pendingMessage: {},
        pendingPreview: "申请测试",
        pendingChatId: "oc_10",
      }).member;

      let sentMarkdown = "";
      const mockClient: any = {
        im: {
          v1: {
            message: {
              reply: async (args: any) => {
                const parsed = JSON.parse(args.data.content);
                sentMarkdown = parsed.text ?? parsed.body?.elements?.[0]?.content ?? "";
                return { code: 0, data: { message_id: "om_reply_10" } };
              },
              create: async (args: any) => {
                const parsed = JSON.parse(args.data.content);
                sentMarkdown = parsed.text ?? parsed.body?.elements?.[0]?.content ?? "";
                return { code: 0, data: {} };
              },
            },
          },
        },
      };

      // 1. 同意命令
      await handleAdminCommand({
        botId: bot.id,
        adminOpenId: "ou_admin_10",
        chatId: "oc_admin_p2p",
        messageId: "om_cmd_1",
        command: { type: "approve", code: member.code },
        client: mockClient,
      });

      expect(sentMarkdown).toContain("已同意");
      expect(getLarkBotMember(bot.id, "ou_user_10")?.status).toBe("approved");

      // 2. 名单命令
      sentMarkdown = "";
      await handleAdminCommand({
        botId: bot.id,
        adminOpenId: "ou_admin_10",
        chatId: "oc_admin_p2p",
        messageId: "om_cmd_2",
        command: { type: "list" },
        client: mockClient,
      });

      expect(sentMarkdown).toContain("成员与权限名单");
      expect(sentMarkdown).toContain("ou_admin_10");
    });
  });

  describe("7. 成员删除与数据维护", () => {
    test("deleteLarkBotMember 移除成员记录", () => {
      const bot = createLarkBot({
        name: "测试 Bot 11",
        appId: "cli_test_bot_11",
        appSecret: "sec_11",
      });

      preapproveMember({
        botId: bot.id,
        openId: "ou_delete_target",
      });
      expect(getLarkBotMember(bot.id, "ou_delete_target")).not.toBeNull();

      const deleted = deleteLarkBotMember(bot.id, "ou_delete_target");
      expect(deleted).toBe(true);
      expect(getLarkBotMember(bot.id, "ou_delete_target")).toBeNull();
    });
  });

  describe("8. acceptLarkEvent 门禁事件流集成", () => {
    test("open 模式：任意消息直接入队", async () => {
      const { acceptLarkEvent } = await import("./handler");
      const { getLarkInbox } = await import("./store");

      const bot = createLarkBot({
        name: "测试 Bot 12",
        appId: "cli_test_bot_12",
        appSecret: "sec_12",
        accessMode: "open",
      });

      const mockClient: any = {
        im: {
          v1: {
            message: { reply: async () => ({ code: 0, data: {} }), create: async () => ({ code: 0, data: {} }) },
            messageReaction: { create: async () => ({ code: 0 }) },
          },
        },
      };

      acceptLarkEvent(bot.id, mockClient, {
        sender: { sender_type: "user", sender_id: { open_id: "ou_user_open" } },
        message: {
          message_id: "om_event_open_1",
          chat_id: "oc_p2p_1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "你好" }),
        },
      });

      const inbox = getLarkInbox("om_event_open_1");
      expect(inbox?.status).toBe("processing");
    });

    test("approval 模式：未审批用户挂起并生成 pending，静默拦截 denied 用户", async () => {
      const { acceptLarkEvent } = await import("./handler");
      const { getLarkInbox, setLarkBotIdentity } = await import("./store");

      const bot = createLarkBot({
        name: "测试 Bot 13",
        appId: "cli_test_bot_13",
        appSecret: "sec_13",
        accessMode: "approval",
      });
      setLarkBotIdentity(bot.id, "ou_bot_open_id", "测试 Bot 13");

      let replyCount = 0;
      let adminNotifyCount = 0;
      const mockClient: any = {
        im: {
          v1: {
            message: {
              reply: async () => {
                replyCount++;
                return { code: 0, data: {} };
              },
              create: async () => {
                adminNotifyCount++;
                return { code: 0, data: {} };
              },
            },
            messageReaction: { create: async () => ({ code: 0 }) },
          },
        },
      };

      // 1. 未审批用户发消息
      acceptLarkEvent(bot.id, mockClient, {
        sender: { sender_type: "user", sender_id: { open_id: "ou_applicant_event" } },
        message: {
          message_id: "om_event_pending_1",
          chat_id: "oc_group_1",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "@_user_1 帮我写个脚本" }),
          mentions: [{ key: "@_user_1", id: { open_id: "ou_bot_open_id" } }],
        },
      });

      await Bun.sleep(20);

      const inboxPending = getLarkInbox("om_event_pending_1");
      expect(inboxPending?.status).toBe("pending");
      const member = getLarkBotMember(bot.id, "ou_applicant_event");
      expect(member?.status).toBe("pending");
      expect(replyCount).toBe(1); // 提示了发送人

      // 2. denied 用户发消息：静默忽略
      const { setMemberDecision } = await import("./store");
      setMemberDecision({ botId: bot.id, openId: "ou_applicant_event", status: "denied", decidedBy: "admin" });

      replyCount = 0;
      acceptLarkEvent(bot.id, mockClient, {
        sender: { sender_type: "user", sender_id: { open_id: "ou_applicant_event" } },
        message: {
          message_id: "om_event_denied_1",
          chat_id: "oc_group_1",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "@_user_1 第二次尝试" }),
          mentions: [{ key: "@_user_1", id: { open_id: "ou_bot_open_id" } }],
        },
      });

      await Bun.sleep(20);

      const inboxDenied = getLarkInbox("om_event_denied_1");
      expect(inboxDenied?.status).toBe("ignored");
      expect(replyCount).toBe(0); // 静默不回
    });
  });
});
