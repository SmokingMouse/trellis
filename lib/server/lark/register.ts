import "server-only";
import crypto from "node:crypto";
import type {
  LarkAccessMode,
  LarkBot,
  LarkBotInput,
  LarkRegisterRequest,
  LarkRegisterSession,
  LarkRegisterStart,
  LarkRegisterStatus,
} from "@/lib/lark-types";
import { reconcileNow } from "./manager";
import { TRELLIS_BOT_ADDONS } from "./scopes";
import {
  createLarkClient,
  lark,
  testLarkCredentials,
  type LarkBotInfo,
  type LarkSdkClient,
} from "./sdk";
import {
  clearLarkBotMissingScopes,
  createLarkBot,
  getLarkBotRecord,
  preapproveMember,
  setLarkBotIdentity,
  updateLarkBot,
  type LarkBotRecord,
} from "./store";

export type LarkRegisterDeps = {
  registerAppFn?: typeof lark.registerApp;
  testCredentialsFn?: (appId: string, appSecret: string) => Promise<LarkBotInfo>;
  createBotFn?: (input: LarkBotInput) => LarkBot;
  updateBotFn?: (id: string, patch: Partial<LarkBotInput> & { missingScopes?: string[] }) => LarkBot | null;
  getBotRecordFn?: (id: string) => LarkBotRecord | null;
  setBotIdentityFn?: (id: string, openId: string | null, name: string | null) => void;
  clearBotMissingScopesFn?: (id: string) => void;
  preapproveMemberFn?: typeof preapproveMember;
  reconcileNowFn?: () => Promise<void>;
  createClientFn?: typeof createLarkClient;
  pollConnectionIntervalMs?: number;
  pollConnectionTimeoutMs?: number;
};

type RegisterAppOptions = Parameters<typeof lark.registerApp>[0];
type RegisterAppResult = Awaited<ReturnType<typeof lark.registerApp>>;
type QRCodeInfo = Parameters<RegisterAppOptions["onQRCodeReady"]>[0];

type RegistrationSessionInternal = LarkRegisterSession & {
  abortController: AbortController;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  createdAt: number;
};

const CLEANUP_DELAY_MS = 10 * 60 * 1000; // 终态会话保留 10 分钟后清理

const globalRegisterSessions = globalThis as typeof globalThis & {
  __trellisLarkRegisterSessions?: Map<string, RegistrationSessionInternal>;
};

function getSessionMap(): Map<string, RegistrationSessionInternal> {
  if (!globalRegisterSessions.__trellisLarkRegisterSessions) {
    globalRegisterSessions.__trellisLarkRegisterSessions = new Map();
  }
  return globalRegisterSessions.__trellisLarkRegisterSessions;
}

function scheduleCleanup(session: RegistrationSessionInternal): void {
  if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
  session.cleanupTimer = setTimeout(() => {
    getSessionMap().delete(session.sessionId);
  }, CLEANUP_DELAY_MS);
  session.cleanupTimer.unref?.();
}

/**
 * 发起扫码注册 / 更新应用流程。
 * 调用飞书 SDK registerApp，等待 onQRCodeReady 后返回会话元信息；
 * 后台持续轮询并在用户确认后完成建 bot / 验凭证 / 设管理员 / 发欢迎私聊等步骤。
 */
export async function startRegistration(
  req: LarkRegisterRequest,
  deps?: LarkRegisterDeps,
): Promise<LarkRegisterStart> {
  const getBot = deps?.getBotRecordFn ?? getLarkBotRecord;
  let targetBot: LarkBotRecord | null = null;
  let addons: lark.AppAddons;

  if (req.mode === "create") {
    if (!req.name || typeof req.name !== "string" || !req.name.trim()) {
      throw new Error("机器人名称不能为空");
    }
    addons = TRELLIS_BOT_ADDONS;
  } else if (req.mode === "update") {
    if (!req.botId || typeof req.botId !== "string" || !req.botId.trim()) {
      throw new Error("botId 不能为空");
    }
    targetBot = getBot(req.botId);
    if (!targetBot) {
      throw new Error(`找不到要更新的机器人（ID: ${req.botId}）`);
    }
    const standardScopes = TRELLIS_BOT_ADDONS.scopes?.tenant ?? [];
    const requestedScopes = req.scopes ?? [];
    const missingScopes = targetBot.missingScopes ?? [];
    const mergedScopes = Array.from(
      new Set([...standardScopes, ...requestedScopes, ...missingScopes]),
    );
    addons = {
      ...TRELLIS_BOT_ADDONS,
      scopes: {
        tenant: mergedScopes,
      },
    };
  } else {
    throw new Error(`未知的注册模式: ${(req as any).mode}`);
  }

  const sessionId = crypto.randomUUID();
  const abortController = new AbortController();

  const session: RegistrationSessionInternal = {
    sessionId,
    mode: req.mode,
    status: "waiting",
    url: "",
    expiresAt: 0,
    botId: req.mode === "update" ? req.botId : null,
    appId: targetBot ? targetBot.appId : null,
    connected: false,
    adminBound: false,
    welcomeSent: false,
    error: null,
    abortController,
    createdAt: Date.now(),
  };

  getSessionMap().set(sessionId, session);

  const registerAppFn = deps?.registerAppFn ?? lark.registerApp;

  return new Promise<LarkRegisterStart>((resolve, reject) => {
    let resolved = false;
    const qrTimeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        abortController.abort();
        session.status = "error";
        session.error = "获取扫码二维码超时（30s）";
        scheduleCleanup(session);
        reject(new Error("获取扫码二维码超时（30s）"));
      }
    }, 30_000);
    qrTimeout.unref?.();

    const options: RegisterAppOptions = {
      source: "trellis",
      signal: abortController.signal,
      onQRCodeReady: (info: QRCodeInfo) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(qrTimeout);
          session.url = info.url;
          session.expiresAt = Date.now() + (info.expireIn ?? 3600) * 1000;
          resolve({
            sessionId,
            url: session.url,
            expiresAt: session.expiresAt,
          });
        }
      },
      addons,
      ...(req.mode === "create"
        ? {
            createOnly: true,
            appPreset: {
              name: req.name.trim(),
              desc: req.description?.trim(),
            },
          }
        : {
            appId: targetBot!.appId,
          }),
    };

    registerAppFn(options)
      .then((result) => handleRegistrationSuccess(session, req, result, deps))
      .catch((err) => handleRegistrationError(session, err));
  });
}

async function handleRegistrationSuccess(
  session: RegistrationSessionInternal,
  req: LarkRegisterRequest,
  result: RegisterAppResult,
  deps?: LarkRegisterDeps,
): Promise<void> {
  session.status = "binding";
  const bindingStartedAt = Date.now();
  session.appId = result.client_id;

  const testCredentials = deps?.testCredentialsFn ?? testLarkCredentials;
  const triggerReconcile = deps?.reconcileNowFn ?? reconcileNow;
  const getBot = deps?.getBotRecordFn ?? getLarkBotRecord;

  try {
    if (req.mode === "create") {
      // 1. 验凭证
      const botInfo = await testCredentials(result.client_id, result.client_secret);

      // 2. 建 bot 记录
      const createBot = deps?.createBotFn ?? createLarkBot;
      const setIdentity = deps?.setBotIdentityFn ?? setLarkBotIdentity;
      const created = createBot({
        name: req.name.trim() || botInfo.name || "飞书机器人",
        appId: result.client_id,
        appSecret: result.client_secret,
        agentId: req.agentId ?? null,
        workspacePath: req.workspacePath ?? null,
        accessMode: req.accessMode ?? "approval",
        enabled: true,
      });
      session.botId = created.id;
      setIdentity(created.id, botInfo.openId, botInfo.name);

      // 3. 把创建者设成管理员
      if (result.user_info?.open_id) {
        const approve = deps?.preapproveMemberFn ?? preapproveMember;
        approve({
          botId: created.id,
          openId: result.user_info.open_id,
          role: "admin",
          name: "创建者",
        });
        session.adminBound = true;
      }

      // 4. 触发 manager 立即对账
      await triggerReconcile();

      // 5. 等长连接连上（最多等 30s）
      const pollTimeout = deps?.pollConnectionTimeoutMs ?? 30_000;
      const pollInterval = deps?.pollConnectionIntervalMs ?? 500;
      const start = Date.now();
      let connected = false;
      while (Date.now() - start < pollTimeout) {
        const rec = getBot(created.id);
        if (rec?.lastConnectedAt && rec.lastConnectedAt >= bindingStartedAt) {
          connected = true;
          break;
        }
        await new Promise((r) => setTimeout(r, pollInterval));
      }
      if (!connected) {
        throw new Error(
          "飞书机器人长连接 30s 内未就绪，请检查开放平台「事件与回调」是否已配置为长连接",
        );
      }
      session.connected = true;

      // 6. 用新 bot 给创建者发送欢迎私聊
      if (result.user_info?.open_id) {
        const agentDesc = req.agentId ? `绑定的 Agent：${req.agentId}` : "未绑定特定 Agent";
        const wsDesc = req.workspacePath ? `工作目录：${req.workspacePath}` : "";
        const welcomeText = `🎉 机器人「${created.name}」已成功接入 Trellis！\n${agentDesc}${wsDesc ? `\n${wsDesc}` : ""}\n你是此机器人的管理员，其他人私聊或 @ 它时需要你的批准。`;

        const createClient = deps?.createClientFn ?? createLarkClient;
        const client = createClient(result.client_id, result.client_secret);
        await client.im.v1.message.create({
          params: { receive_id_type: "open_id" },
          data: {
            receive_id: result.user_info.open_id,
            msg_type: "text",
            content: JSON.stringify({ text: welcomeText }),
          },
        });
        session.welcomeSent = true;
      }

      session.status = "done";
      scheduleCleanup(session);
    } else {
      // update 流程
      const bot = getBot(req.botId);
      if (!bot) {
        throw new Error(`机器人记录不存在（ID: ${req.botId}）`);
      }

      // 1. 校验 client_id 是否一致
      if (result.client_id !== bot.appId) {
        throw new Error("确认的不是这个应用（App ID 不匹配）");
      }

      // 2. 验凭证
      const botInfo = await testCredentials(result.client_id, result.client_secret);

      // 3. 更新 secret 与身份
      const updateBot = deps?.updateBotFn ?? updateLarkBot;
      const setIdentity = deps?.setBotIdentityFn ?? setLarkBotIdentity;
      if (result.client_secret && result.client_secret !== bot.appSecret) {
        updateBot(bot.id, { appSecret: result.client_secret });
      }
      setIdentity(bot.id, botInfo.openId, botInfo.name);

      // 4. 清空 missingScopes
      const clearMissing = deps?.clearBotMissingScopesFn ?? clearLarkBotMissingScopes;
      clearMissing(bot.id);

      // 5. 触发立即对账
      await triggerReconcile();

      // 6. 等连上（非阻塞，成功对账即置 connected）
      const pollTimeout = deps?.pollConnectionTimeoutMs ?? 15_000;
      const pollInterval = deps?.pollConnectionIntervalMs ?? 500;
      const start = Date.now();
      let connected = false;
      while (Date.now() - start < pollTimeout) {
        const rec = getBot(bot.id);
        if (rec?.lastConnectedAt && rec.lastConnectedAt >= bindingStartedAt) {
          connected = true;
          break;
        }
        await new Promise((r) => setTimeout(r, pollInterval));
      }
      session.connected = connected;

      session.status = "done";
      scheduleCleanup(session);
    }
  } catch (error) {
    session.status = "error";
    session.error = error instanceof Error ? error.message : String(error);
    scheduleCleanup(session);
  }
}

function handleRegistrationError(session: RegistrationSessionInternal, err: unknown): void {
  const code = (err as any)?.code;
  const desc =
    (err as any)?.description || (err instanceof Error ? err.message : String(err));
  if (code === "access_denied") {
    session.status = "denied";
    session.error = "用户在飞书确认页取消授权";
  } else if (code === "expired_token") {
    session.status = "expired";
    session.error = "二维码已过期，请重新发起";
  } else if (code === "abort" || session.abortController.signal.aborted) {
    session.status = "cancelled";
    session.error = "注册流程已取消";
  } else {
    session.status = "error";
    session.error = desc;
  }
  scheduleCleanup(session);
}

/** 获取会话当前公开状态。 */
export function getRegistration(sessionId: string): LarkRegisterSession | null {
  const session = getSessionMap().get(sessionId);
  if (!session) return null;
  const {
    abortController: _abort,
    cleanupTimer: _timer,
    createdAt: _created,
    ...publicSession
  } = session;
  return publicSession;
}

/** 取消进行中的会话。 */
export function cancelRegistration(sessionId: string): boolean {
  const session = getSessionMap().get(sessionId);
  if (!session) return false;
  if (
    session.status === "done" ||
    session.status === "cancelled" ||
    session.status === "denied" ||
    session.status === "expired"
  ) {
    return true;
  }
  session.abortController.abort();
  session.status = "cancelled";
  session.error = "注册流程已取消";
  scheduleCleanup(session);
  return true;
}

/** 测试辅助：清空会话缓存 */
export function clearRegistrationSessions(): void {
  const map = getSessionMap();
  for (const s of map.values()) {
    if (s.cleanupTimer) clearTimeout(s.cleanupTimer);
  }
  map.clear();
}
