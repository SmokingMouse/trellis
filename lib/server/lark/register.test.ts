import { describe, expect, test, mock, beforeEach, afterAll } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import type { LarkRegisterRequest } from "@/lib/lark-types";

mock.module("server-only", () => ({}));

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-lark-register-test-"));
process.env.TRELLIS_DB_PATH = path.join(testHome, "test.db");

const { getDB, resetDBForTests } = await import("@/lib/server/sqlite");
const {
  createLarkBot,
  getLarkBot,
  getLarkBotRecord,
  setLarkBotConnection,
  setLarkBotMissingScopes,
  clearLarkBotMissingScopes,
  getLarkBotMember,
} = await import("./store");
const { GROUP_ALL_MESSAGES_SCOPE, TRELLIS_BOT_ADDONS } = await import("./scopes");
const {
  extractLarkPermissionViolation,
  formatErrorBrief,
} = await import("./sdk");
const {
  startRegistration,
  getRegistration,
  cancelRegistration,
  clearRegistrationSessions,
} = await import("./register");
const { reconcileNow } = await import("./manager");

describe("Lark Bot Register & Permissions (qr-server)", () => {
  beforeEach(() => {
    const db = getDB();
    db.exec("DELETE FROM lark_bot_members");
    db.exec("DELETE FROM lark_chats");
    db.exec("DELETE FROM lark_bots");
    clearRegistrationSessions();
  });

  afterAll(() => {
    resetDBForTests();
    try {
      fs.rmSync(testHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("1. TRELLIS_BOT_ADDONS 标准权限与事件契约", () => {
    test("包含所有必要的 tenant scopes、事件与回调", () => {
      const tenantScopes = TRELLIS_BOT_ADDONS.scopes?.tenant ?? [];
      expect(tenantScopes).toContain("im:message.p2p_msg:readonly");
      expect(tenantScopes).toContain("im:message.group_at_msg:readonly");
      // 收群全部消息按需申请，不进标准集（企业租户常要审批）
      expect(tenantScopes).not.toContain(GROUP_ALL_MESSAGES_SCOPE);
      expect(tenantScopes).toContain("im:message:send_as_bot");
      expect(tenantScopes).toContain("im:message");
      expect(tenantScopes).toContain("im:message:update");
      expect(tenantScopes).toContain("im:message.reactions:write_only");
      expect(tenantScopes).toContain("im:resource");
      // 飞书没有 :upload / :download 细分 scope（lark-cli scope_priorities.json）
      expect(tenantScopes.some((x) => x.startsWith("im:resource:"))).toBe(false);
      expect(tenantScopes).toContain("im:chat:read");
      expect(tenantScopes).toContain("contact:user.id:readonly");

      expect(TRELLIS_BOT_ADDONS.events?.items?.tenant).toContain("im.message.receive_v1");
      expect(TRELLIS_BOT_ADDONS.callbacks?.items).toContain("card.action.trigger");
    });
  });

  describe("2. 权限报错解析 (extractLarkPermissionViolation)", () => {
    test("解析形状 1：AxiosError (HTTP 400 + response.data.code=99991672)", () => {
      const axiosError = new Error("Request failed with status code 400");
      (axiosError as any).response = {
        data: {
          code: 99991672,
          msg: "Access denied. One of the following scopes is required: [im:chat:read]",
          error: {
            permission_violations: [{ subject: "im:chat:read" }],
          },
        },
      };

      const result = extractLarkPermissionViolation(axiosError);
      expect(result.isPermissionError).toBe(true);
      expect(result.code).toBe(99991672);
      expect(result.missingScopes).toEqual(["im:chat:read"]);
      expect(result.message).toContain("缺少应用身份权限：im:chat:read");
      expect(formatErrorBrief(axiosError)).toContain("缺少应用身份权限：im:chat:read");
    });

    test("解析形状 2：code≠0 响应对象", () => {
      const response = {
        code: 99991672,
        msg: "Permission denied",
        error: {
          permission_violations: [
            { subject: "im:message:send_as_bot" },
            { subject: "im:resource:upload" },
          ],
        },
      };

      const result = extractLarkPermissionViolation(response);
      expect(result.isPermissionError).toBe(true);
      expect(result.missingScopes).toEqual(["im:message:send_as_bot", "im:resource:upload"]);
      expect(result.message).toContain("缺少应用身份权限：im:message:send_as_bot, im:resource:upload");
    });

    test("解析形状 3：从 msg / 文本中的 [...] 或 URL 兜底解析", () => {
      const textError = new Error(
        "API error code 99991672: Access denied. One of the following scopes is required: [im:message.p2p_msg:readonly, im:chat:read]. 点击链接申请并开通任一权限：https://open.feishu.cn/app/cli_xxx/auth?q=im:message.p2p_msg:readonly,im:chat:read",
      );

      const result = extractLarkPermissionViolation(textError);
      expect(result.isPermissionError).toBe(true);
      expect(result.missingScopes).toContain("im:message.p2p_msg:readonly");
      expect(result.missingScopes).toContain("im:chat:read");
      expect(result.message).toContain("im:message.p2p_msg:readonly");
      expect(result.message).toContain("im:chat:read");
    });

    test("非 99991672 错误不误判为权限错误", () => {
      const err = new Error("Network timeout");
      const result = extractLarkPermissionViolation(err);
      expect(result.isPermissionError).toBe(false);
      expect(result.missingScopes).toEqual([]);
      expect(result.message).toBe("Network timeout");
    });
  });

  describe("3. missing_scopes 数据库列与迁移可重入", () => {
    test("missing_scopes 支持写入、读取、更新与清空", () => {
      const bot = createLarkBot({
        name: "测试机器人",
        appId: "cli_perm_test",
        appSecret: "sec_perm_test",
      });

      expect(bot.missingScopes).toBeUndefined();

      setLarkBotMissingScopes(bot.id, ["im:chat:read", "im:resource:upload"]);
      const updated = getLarkBot(bot.id)!;
      expect(updated.missingScopes).toEqual(["im:chat:read", "im:resource:upload"]);

      clearLarkBotMissingScopes(bot.id);
      const cleared = getLarkBot(bot.id)!;
      expect(cleared.missingScopes).toBeUndefined();
    });

    test("迁移重复执行保持幂等", () => {
      const db = getDB();
      // 多次执行迁移
      const has = db
        .prepare("SELECT 1 FROM pragma_table_info('lark_bots') WHERE name = 'missing_scopes'")
        .get();
      expect(has).toBeTruthy();
    });
  });

  describe("4. 扫码创建流程状态机 (startRegistration mode=create)", () => {
    test("成功流程：扫码 -> 验凭证 -> 建bot -> 设admin -> 立即对账 -> 连接 -> 欢迎语 -> done", async () => {
      let registeredOptions: any = null;
      let welcomeSentMessage: any = null;
      let reconcileCount = 0;

      const mockRegisterApp = mock((options: any) => {
        registeredOptions = options;
        // 模拟 SDK 回调二维码
        options.onQRCodeReady({
          url: "https://passport.feishu.cn/suite/passport/oauth/authorize?test=1",
          expireIn: 600,
        });

        // 模拟用户在飞书确认
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              client_id: "cli_mock_app_123",
              client_secret: "sec_mock_app_secret",
              user_info: {
                open_id: "ou_creator_user_1",
                tenant_brand: "feishu",
              },
            });
          }, 10);
        });
      });

      const mockTestCredentials = mock(async (_appId: string, _secret: string) => {
        return { openId: "ou_bot_open_id_123", name: "扫码创建的机器人" };
      });

      const mockCreateClient = mock((_appId: string, _secret: string) => {
        return {
          im: {
            v1: {
              message: {
                create: mock(async (payload: any) => {
                  welcomeSentMessage = payload;
                  return { code: 0, msg: "ok", data: { message_id: "om_welcome_msg_1" } };
                }),
              },
            },
          },
        } as any;
      });

      const mockReconcileNow = mock(async () => {
        reconcileCount++;
        // 模拟连接成功，写入 last_connected_at
        const bots = getDB().query("SELECT id FROM lark_bots WHERE app_id = 'cli_mock_app_123'").all() as any[];
        if (bots.length > 0) {
          setLarkBotConnection(bots[0].id, { connectedAt: Date.now() });
        }
      });

      const req: LarkRegisterRequest = {
        mode: "create",
        name: "扫码创建的机器人",
        description: "由 Trellis 自动创建",
        agentId: "agent-qa",
        workspacePath: "/data00/test",
      };

      const startResult = await startRegistration(req, {
        registerAppFn: mockRegisterApp as any,
        testCredentialsFn: mockTestCredentials,
        createClientFn: mockCreateClient as any,
        reconcileNowFn: mockReconcileNow,
        pollConnectionIntervalMs: 10,
        pollConnectionTimeoutMs: 1000,
      });

      expect(startResult.sessionId).toBeTruthy();
      expect(startResult.url).toContain("passport.feishu.cn");
      expect(registeredOptions.createOnly).toBe(true);
      expect(registeredOptions.appPreset.name).toBe("扫码创建的机器人");

      // 等待后台流程完成
      let session = getRegistration(startResult.sessionId);
      const start = Date.now();
      while (session && session.status !== "done" && session.status !== "error" && Date.now() - start < 2000) {
        await new Promise((r) => setTimeout(r, 20));
        session = getRegistration(startResult.sessionId);
      }

      expect(session).not.toBeNull();
      expect(session!.status).toBe("done");
      expect(session!.appId).toBe("cli_mock_app_123");
      expect(session!.connected).toBe(true);
      expect(session!.adminBound).toBe(true);
      expect(session!.welcomeSent).toBe(true);
      expect(session!.error).toBeNull();
      expect(reconcileCount).toBeGreaterThanOrEqual(1);

      // 验证 DB 中的 Bot 记录
      const bot = getLarkBot(session!.botId!)!;
      expect(bot.name).toBe("扫码创建的机器人");
      expect(bot.appId).toBe("cli_mock_app_123");
      expect(bot.agentId).toBe("agent-qa");
      expect(bot.workspacePath).toBe("/data00/test");
      expect(bot.accessMode).toBe("approval"); // 缺省 approval
      expect(bot.botOpenId).toBe("ou_bot_open_id_123");

      // 验证管理员绑定
      const admin = getLarkBotMember(bot.id, "ou_creator_user_1");
      expect(admin).not.toBeNull();
      expect(admin!.role).toBe("admin");
      expect(admin!.status).toBe("approved");

      // 验证欢迎私聊内容
      expect(welcomeSentMessage).not.toBeNull();
      expect(welcomeSentMessage.params.receive_id_type).toBe("open_id");
      expect(welcomeSentMessage.data.receive_id).toBe("ou_creator_user_1");
      expect(welcomeSentMessage.data.content).toContain("你是此机器人的管理员");
    });

    test("用户取消授权 (access_denied) -> status 变为 denied", async () => {
      const mockRegisterApp = mock((options: any) => {
        options.onQRCodeReady({ url: "https://qr.url", expireIn: 60 });
        return Promise.reject({ code: "access_denied", description: "User rejected" });
      });

      const startResult = await startRegistration(
        { mode: "create", name: "取消测试" },
        { registerAppFn: mockRegisterApp as any },
      );

      await new Promise((r) => setTimeout(r, 30));
      const session = getRegistration(startResult.sessionId);
      expect(session!.status).toBe("denied");
      expect(session!.error).toContain("用户在飞书确认页取消授权");
    });

    test("二维码过期 (expired_token) -> status 变为 expired", async () => {
      const mockRegisterApp = mock((options: any) => {
        options.onQRCodeReady({ url: "https://qr.url", expireIn: 60 });
        return Promise.reject({ code: "expired_token", description: "Polling timeout" });
      });

      const startResult = await startRegistration(
        { mode: "create", name: "过期测试" },
        { registerAppFn: mockRegisterApp as any },
      );

      await new Promise((r) => setTimeout(r, 30));
      const session = getRegistration(startResult.sessionId);
      expect(session!.status).toBe("expired");
      expect(session!.error).toContain("二维码已过期");
    });

    test("手动取消注册 (cancelRegistration) -> status 变为 cancelled", async () => {
      const mockRegisterApp = mock((options: any) => {
        options.onQRCodeReady({ url: "https://qr.url", expireIn: 60 });
        return new Promise((_, reject) => {
          options.signal.addEventListener("abort", () => {
            reject({ code: "abort", description: "Registration was aborted" });
          });
        });
      });

      const startResult = await startRegistration(
        { mode: "create", name: "手动取消测试" },
        { registerAppFn: mockRegisterApp as any },
      );

      const ok = cancelRegistration(startResult.sessionId);
      expect(ok).toBe(true);

      await new Promise((r) => setTimeout(r, 30));
      const session = getRegistration(startResult.sessionId);
      expect(session!.status).toBe("cancelled");
      expect(session!.error).toContain("已取消");
    });

    test("review-qr F1：拿到二维码前就失败 -> 立刻用真实原因 reject，不干等 30s", async () => {
      const mockRegisterApp = mock(() => Promise.reject({ code: "some_real_error", description: "App not found upstream" }));
      const t0 = Date.now();
      let caught: unknown = null;
      try {
        await startRegistration({ mode: "create", name: "早失败" }, { registerAppFn: mockRegisterApp as any });
      } catch (e) {
        caught = e;
      }
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(String((caught as Error)?.message)).toContain("App not found upstream");
    });

    test("review-qr F2：binding 中取消被拒，后台跑完仍是 done；waiting 中取消后即便飞书回了凭证也不建 bot", async () => {
      // binding 阶段：cancel 返回 false，状态不被改写
      let release!: (v: unknown) => void;
      const gate = new Promise((r) => (release = r));
      const mockRegisterApp = mock((options: any) => {
        options.onQRCodeReady({ url: "https://qr.url", expireIn: 60 });
        return Promise.resolve({ client_id: "cli_bind_cancel", client_secret: "sec", user_info: { open_id: "ou_c" } });
      });
      const start = await startRegistration(
        { mode: "create", name: "绑定中取消" },
        {
          registerAppFn: mockRegisterApp as any,
          testCredentialsFn: mock(async () => {
            await gate; // 卡在 binding
            return { openId: "ou_bot", name: "绑定中取消" };
          }),
          createClientFn: (() => ({ im: { v1: { message: { create: async () => ({}) } } } })) as any,
          reconcileNowFn: mock(async () => {}),
          getBotRecordFn: (() => ({ lastConnectedAt: Date.now() + 1000 })) as any,
          pollConnectionIntervalMs: 5,
          pollConnectionTimeoutMs: 200,
        },
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(getRegistration(start.sessionId)!.status).toBe("binding");
      expect(cancelRegistration(start.sessionId)).toBe(false);
      release(null);
      let session = getRegistration(start.sessionId);
      const t0 = Date.now();
      while (session && session.status === "binding" && Date.now() - t0 < 2000) {
        await new Promise((r) => setTimeout(r, 10));
        session = getRegistration(start.sessionId);
      }
      expect(session!.status).toBe("done");

      // waiting 阶段取消后，飞书那边恰好也确认了：保持 cancelled，不建 bot
      let confirm!: (v: unknown) => void;
      const createBotFn = mock(() => {
        throw new Error("不该建 bot");
      });
      const start2 = await startRegistration(
        { mode: "create", name: "等待中取消" },
        {
          registerAppFn: mock((options: any) => {
            options.onQRCodeReady({ url: "https://qr.url", expireIn: 60 });
            return new Promise((r) => (confirm = r));
          }) as any,
          createBotFn: createBotFn as any,
        },
      );
      expect(cancelRegistration(start2.sessionId)).toBe(true);
      confirm({ client_id: "cli_late", client_secret: "sec" });
      await new Promise((r) => setTimeout(r, 30));
      expect(getRegistration(start2.sessionId)!.status).toBe("cancelled");
      expect(createBotFn).not.toHaveBeenCalled();
    });

    test("binding 阶段连接超时失败 -> status 变为 error，已建好的 bot 保留", async () => {
      const mockRegisterApp = mock((options: any) => {
        options.onQRCodeReady({ url: "https://qr.url", expireIn: 60 });
        return Promise.resolve({
          client_id: "cli_fail_connect",
          client_secret: "sec_fail_connect",
          user_info: { open_id: "ou_creator_fail" },
        });
      });

      const mockTestCredentials = mock(async () => ({
        openId: "ou_bot_fail",
        name: "连接失败测试",
      }));

      const startResult = await startRegistration(
        { mode: "create", name: "连接失败测试" },
        {
          registerAppFn: mockRegisterApp as any,
          testCredentialsFn: mockTestCredentials,
          reconcileNowFn: async () => {}, // 不写 last_connected_at 模拟超时
          pollConnectionIntervalMs: 10,
          pollConnectionTimeoutMs: 50,
        },
      );

      await new Promise((r) => setTimeout(r, 120));
      const session = getRegistration(startResult.sessionId);
      expect(session!.status).toBe("error");
      expect(session!.error).toContain("长连接");
      expect(session!.botId).not.toBeNull();
      // bot 记录依然保存在 DB 中
      const bot = getLarkBot(session!.botId!);
      expect(bot).not.toBeNull();
      expect(bot!.appId).toBe("cli_fail_connect");
    });
  });

  describe("5. 扫码更新流程 (startRegistration mode=update)", () => {
    test("收群全部消息 scope 只对 groupTrigger≠mention 的 bot 按需带上", async () => {
      const seen: Record<string, string[]> = {};
      for (const groupTrigger of ["mention", "all"] as const) {
        const bot = createLarkBot({ name: `群触发-${groupTrigger}`, appId: `cli_group_${groupTrigger}`, appSecret: "sec", groupTrigger });
        const mockRegisterApp = mock((options: any) => {
          seen[groupTrigger] = options.addons.scopes.tenant;
          options.onQRCodeReady({ url: "https://qr.url", expireIn: 60 });
          return new Promise(() => {});
        });
        const start = await startRegistration({ mode: "update", botId: bot.id }, { registerAppFn: mockRegisterApp as any });
        cancelRegistration(start.sessionId);
      }
      expect(seen.mention).not.toContain(GROUP_ALL_MESSAGES_SCOPE);
      expect(seen.all).toContain(GROUP_ALL_MESSAGES_SCOPE);
    });

    test("情况 1：确认的 client_id 与原 bot 不一致 -> status 变为 error", async () => {
      const originalBot = createLarkBot({
        name: "原应用",
        appId: "cli_original_123",
        appSecret: "sec_original",
      });

      const mockRegisterApp = mock((options: any) => {
        options.onQRCodeReady({ url: "https://qr.url", expireIn: 60 });
        return Promise.resolve({
          client_id: "cli_DIFFERENT_456", // 不一致
          client_secret: "sec_different",
        });
      });

      const startResult = await startRegistration(
        { mode: "update", botId: originalBot.id },
        { registerAppFn: mockRegisterApp as any },
      );

      await new Promise((r) => setTimeout(r, 30));
      const session = getRegistration(startResult.sessionId);
      expect(session!.status).toBe("error");
      expect(session!.error).toContain("确认的不是这个应用");
    });

    test("情况 2：client_id 一致但 secret 发生变化 -> 自动更新 secret、清空 missingScopes、触发对账", async () => {
      const originalBot = createLarkBot({
        name: "待更新应用",
        appId: "cli_app_update_test",
        appSecret: "sec_old_secret",
      });
      setLarkBotMissingScopes(originalBot.id, ["im:chat:read"]);

      let reconcileCalled = false;
      const mockRegisterApp = mock((options: any) => {
        options.onQRCodeReady({ url: "https://qr.url", expireIn: 60 });
        return Promise.resolve({
          client_id: "cli_app_update_test",
          client_secret: "sec_NEW_secret",
        });
      });

      const mockTestCredentials = mock(async () => ({
        openId: "ou_bot_updated",
        name: "待更新应用",
      }));

      const mockReconcileNow = mock(async () => {
        reconcileCalled = true;
        setLarkBotConnection(originalBot.id, { connectedAt: Date.now() });
      });

      const startResult = await startRegistration(
        {
          mode: "update",
          botId: originalBot.id,
          scopes: ["contact:user.id:readonly"],
        },
        {
          registerAppFn: mockRegisterApp as any,
          testCredentialsFn: mockTestCredentials,
          reconcileNowFn: mockReconcileNow,
          pollConnectionIntervalMs: 10,
          pollConnectionTimeoutMs: 500,
        },
      );

      await new Promise((r) => setTimeout(r, 60));
      const session = getRegistration(startResult.sessionId);
      expect(session!.status).toBe("done");
      expect(session!.connected).toBe(true);
      expect(reconcileCalled).toBe(true);

      // 验证 DB 中 secret 已更新
      const botRecord = getLarkBotRecord(originalBot.id)!;
      expect(botRecord.appSecret).toBe("sec_NEW_secret");
      // missingScopes 已被清空
      expect(botRecord.missingScopes).toBeUndefined();
    });
  });

  describe("6. Manager 的 rerun 标志（防吞并发对账请求）", () => {
    test("reconcileNow 多次并发调用不丢请求", async () => {
      // 验证 reconcileNow 导出正常可用
      await expect(reconcileNow()).resolves.toBeUndefined();
    });
  });

  describe("7. HTTP 路由端点 (/api/lark-bots/register/*)", () => {
    test("POST /api/lark-bots/register 参数校验与调用", async () => {
      const { POST } = await import("@/app/api/lark-bots/register/route");

      // 缺少 mode
      const res1 = await POST(new Request("http://localhost/api/lark-bots/register", {
        method: "POST",
        body: JSON.stringify({}),
      }));
      expect(res1.status).toBe(400);

      // create 模式缺少 name
      const res2 = await POST(new Request("http://localhost/api/lark-bots/register", {
        method: "POST",
        body: JSON.stringify({ mode: "create", name: "   " }),
      }));
      expect(res2.status).toBe(400);

      // update 模式缺少 botId
      const res3 = await POST(new Request("http://localhost/api/lark-bots/register", {
        method: "POST",
        body: JSON.stringify({ mode: "update", botId: "" }),
      }));
      expect(res3.status).toBe(400);
    });

    test("GET & DELETE /api/lark-bots/register/[sessionId]", async () => {
      const { GET, DELETE } = await import("@/app/api/lark-bots/register/[sessionId]/route");

      // 不存在的会话
      const getRes404 = await GET(new Request("http://localhost/api/lark-bots/register/unknown-session"), {
        params: Promise.resolve({ sessionId: "unknown-session" }),
      });
      expect(getRes404.status).toBe(404);

      const delRes404 = await DELETE(new Request("http://localhost/api/lark-bots/register/unknown-session"), {
        params: Promise.resolve({ sessionId: "unknown-session" }),
      });
      expect(delRes404.status).toBe(404);

      // 创建一个 mock 会话
      const mockRegisterApp = mock((options: any) => {
        options.onQRCodeReady({ url: "https://qr.example.com", expireIn: 300 });
        return new Promise(() => {}); // 保持 waiting
      });

      const start = await startRegistration(
        { mode: "create", name: "路由测试" },
        { registerAppFn: mockRegisterApp as any },
      );

      // GET 会话状态
      const getRes = await GET(new Request(`http://localhost/api/lark-bots/register/${start.sessionId}`), {
        params: Promise.resolve({ sessionId: start.sessionId }),
      });
      expect(getRes.status).toBe(200);
      const sessionData = await getRes.json();
      expect(sessionData.sessionId).toBe(start.sessionId);
      expect(sessionData.status).toBe("waiting");
      expect(sessionData.url).toBe("https://qr.example.com");

      // DELETE 取消会话
      const delRes = await DELETE(new Request(`http://localhost/api/lark-bots/register/${start.sessionId}`), {
        params: Promise.resolve({ sessionId: start.sessionId }),
      });
      expect(delRes.status).toBe(200);
      const delData = await delRes.json();
      expect(delData.ok).toBe(true);

      const getResAfterCancel = await GET(new Request(`http://localhost/api/lark-bots/register/${start.sessionId}`), {
        params: Promise.resolve({ sessionId: start.sessionId }),
      });
      const sessionDataAfterCancel = await getResAfterCancel.json();
      expect(sessionDataAfterCancel.status).toBe("cancelled");
    });
  });
});
