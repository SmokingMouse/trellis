import * as lark from "@larksuiteoapi/node-sdk";

const appId = process.env.LARK_SMOKE_APP_ID;
const appSecret = process.env.LARK_SMOKE_APP_SECRET;

if (!appId || !appSecret) {
  console.log("SKIP: set LARK_SMOKE_APP_ID and LARK_SMOKE_APP_SECRET to test a real Lark WS connection");
  process.exit(0);
}

let settle: (() => void) | undefined;
let reject: ((error: Error) => void) | undefined;
const connected = new Promise<void>((resolve, rejectPromise) => {
  settle = resolve;
  reject = rejectPromise;
});

const wsOptions: ConstructorParameters<typeof lark.WSClient>[0] & { appType: lark.AppType } = {
  appId,
  appSecret,
  appType: lark.AppType.SelfBuild,
  autoReconnect: false,
  handshakeTimeoutMs: 15_000,
  loggerLevel: lark.LoggerLevel.info,
  onReady: () => settle?.(),
  onError: (error) => reject?.(error),
};
const wsClient = new lark.WSClient(wsOptions);

const timeout = setTimeout(() => reject?.(new Error("Lark WS connection timed out after 20s")), 20_000);

try {
  await Promise.all([
    wsClient.start({ eventDispatcher: new lark.EventDispatcher({}) }),
    connected,
  ]);
  console.log("connected");
} finally {
  clearTimeout(timeout);
  wsClient.close({ force: true });
}
