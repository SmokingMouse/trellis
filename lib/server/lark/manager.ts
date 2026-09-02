import "server-only";
import { acceptLarkEvent } from "./handler";
import { diffLarkConnections, type LarkMessageEvent } from "./protocol";
import { createLarkClient, fetchLarkBotInfo, lark, type LarkSdkClient } from "./sdk";
import {
  listLarkBotRecords,
  setLarkBotConnection,
  setLarkBotIdentity,
  type LarkBotRecord,
} from "./store";

const RECONCILE_INTERVAL_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
// 握手超时 + 一点余量：正常路径 onReady 在 1s 内到（S134 实测 0.4–0.6s）。
const READY_TIMEOUT_MS = HANDSHAKE_TIMEOUT_MS + 5_000;

type ActiveConnection = {
  fingerprint: string;
  client: LarkSdkClient;
  wsClient: InstanceType<typeof lark.WSClient>;
};

const ACTIVE = new Map<string, ActiveConnection>();
let started = false;
let reconciling = false;

function fingerprint(bot: LarkBotRecord): string {
  return `${bot.appId}\0${bot.appSecret}`;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function connect(bot: LarkBotRecord): Promise<void> {
  const client = createLarkClient(bot.appId, bot.appSecret);
  let identityError: string | null = null;
  try {
    const info = await fetchLarkBotInfo(client);
    setLarkBotIdentity(bot.id, info.openId, info.name);
  } catch (error) {
    // P2P 仍可工作；群聊因 open_id 不可知而在 parseIncomingEvent fail-closed。
    identityError = `已连接配置，但 bot 信息拉取失败：${errorText(error)}`;
    setLarkBotIdentity(bot.id, null, null);
  }

  const dispatcher = new lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (event: LarkMessageEvent) => {
      acceptLarkEvent(bot.id, client, event);
    },
  });
  // S134 就绪门：SDK 的 `start()` 在拿到 ws 地址后就 resolve（state=connecting），
  // 底层 socket 握手失败时只 logger.error("ws connect failed")，onError / onReconnecting
  // 一个都不回调 —— 于是 last_error 为空、last_connected_at 为空、日志零 [lark] 行，
  // 界面上「已保存、无错误、就是没反应」。唯一可靠的判据是等 onReady，等不到就算失败。
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  // SDK 运行时接受/默认 SelfBuild，但 1.73 的 WS 构造类型漏了 appType；交集类型
  // 保留显式契约，同时不退回 any。
  const wsOptions: ConstructorParameters<typeof lark.WSClient>[0] & { appType: lark.AppType } = {
    appId: bot.appId,
    appSecret: bot.appSecret,
    appType: lark.AppType.SelfBuild,
    loggerLevel: lark.LoggerLevel.info,
    handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
    onReady: () => {
      markReady();
      setLarkBotConnection(bot.id, {
        connectedAt: Date.now(),
        error: identityError,
      });
    },
    onReconnected: () => setLarkBotConnection(bot.id, {
      connectedAt: Date.now(),
      error: identityError,
    }),
    onReconnecting: () => setLarkBotConnection(bot.id, { error: "飞书长连接正在重连" }),
    onError: (error) => setLarkBotConnection(bot.id, { error: errorText(error) }),
  };
  const wsClient = new lark.WSClient(wsOptions);
  ACTIVE.set(bot.id, { fingerprint: fingerprint(bot), client, wsClient });
  try {
    await wsClient.start({ eventDispatcher: dispatcher });
    const state = wsClient.getConnectionStatus().state;
    if (state === "idle" || state === "failed") {
      throw new Error(`飞书长连接未启动（state=${state}），请检查 app_id`);
    }
    const isReady = await Promise.race([
      ready.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), READY_TIMEOUT_MS).unref?.()),
    ]);
    if (!isReady) {
      throw new Error(
        `飞书长连接 ${READY_TIMEOUT_MS / 1000}s 内未就绪（state=${wsClient.getConnectionStatus().state}）。` +
          "SDK 握手失败不回调，只能超时判定。常见原因：① `ws` 被打进 server bundle，Bun 下握手报 " +
          "`Unexpected server response: 101`（next.config serverExternalPackages 必须含 " +
          "@larksuiteoapi/node-sdk 与 ws）；② 开放平台「事件与回调 → 订阅方式」未选长连接。",
      );
    }
    console.info(`[lark] bot ${bot.id} 长连接就绪 app=${bot.appId}`);
  } catch (error) {
    ACTIVE.delete(bot.id);
    wsClient.close({ force: true });
    throw error;
  }
}

function disconnect(botId: string): void {
  const active = ACTIVE.get(botId);
  if (!active) return;
  ACTIVE.delete(botId);
  active.wsClient.close({ force: true });
}

async function reconcile(): Promise<void> {
  if (reconciling) return;
  reconciling = true;
  try {
    const bots = listLarkBotRecords(true);
    const byId = new Map(bots.map((bot) => [bot.id, bot]));
    const desired = bots.map((bot) => ({ id: bot.id, fingerprint: fingerprint(bot) }));
    const active = [...ACTIVE].map(([id, connection]) => {
      const state = connection.wsClient.getConnectionStatus().state;
      const unhealthy = state === "idle" || state === "failed";
      return {
        id,
        fingerprint: unhealthy ? `${connection.fingerprint}\0${state}` : connection.fingerprint,
      };
    });
    const diff = diffLarkConnections(desired, active);
    for (const id of diff.disconnect) disconnect(id);
    for (const id of diff.connect) {
      const bot = byId.get(id);
      if (!bot) continue;
      try {
        await connect(bot);
      } catch (error) {
        setLarkBotConnection(id, { error: errorText(error) });
        console.error(`[lark] bot ${id} 连接失败`, error);
      }
    }
  } finally {
    reconciling = false;
  }
}

/**
 * route 只写 DB；instrumentation 所在 bundle 每 15 秒自行对账。
 * 模块实例不共享，因此这里不导出 ACTIVE，也不提供 route 直连入口。
 */
export function startLarkManager(): void {
  if (process.env.TRELLIS_LARK === "off") return;
  if (started) return;
  started = true;
  void reconcile();
  const timer = setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);
  timer.unref?.();
}
