// trellis 的大门（S1 P1'，progress/project-workspace-layer.md）。
//
// 为什么不是直接 `next start`：终端必须是这个平台的一个**接口**——同一个域名、
// 同一个端口、同一个 cookie 闸，本机和远程走完全相同的 URL。而终端是 WebSocket，
// Next 的 App Router 不能升级 WS，bun 的 node:http upgrade socket 又写不回客户端
// （两条都实测过，见 progress 的 Verified Facts）。唯一能同时满足「同源」和
// 「WS 可用」的位置，就是在 Next 前面放一个 Bun.serve —— 它的原生 WebSocket 是好的。
//
//   :PORT  server.ts (Bun.serve)
//      ├─ /term/*  → ttyd 127.0.0.1:<ttydPort>   （HTTP + WS，先校 cookie）
//      └─ /*       → next start 127.0.0.1:<nextPort>
//
// 三条承重属性都已实测：WS upgrade 通、**SSE 逐条增量到达**（~4ms 开销，没被
// 缓冲——trellis 整个对话是 SSE，缓冲了就全瘫）、POST 请求体透传。
//
// 部署面刻意零改动：launchd plist 调的是 `bun --bun run start -- -p 3088`，
// 我们只把 package.json 的 start 指到本文件，并在这里认 `-p`。

import { spawn, type Subprocess } from "bun";
import { AUTH_COOKIE } from "./lib/auth-cookie";
import { hasTtyd, TTYD_HOST_DEPENDENCY_NOTE } from "./lib/ttyd-dependency";
import {
  deployPaths,
  isDeployStateFresh,
  readDeployState,
  readReleaseInfo,
  tailLog,
} from "./lib/deploy-state";

const argv = process.argv.slice(2);
const pIdx = argv.findIndex((a) => a === "-p" || a === "--port");
const PORT =
  Number(pIdx >= 0 ? argv[pIdx + 1] : undefined) ||
  Number(process.env.PORT) ||
  3088;

// Next 挪到一个只监听 127.0.0.1 的内部端口 —— 外面只应该看得见大门。
const NEXT_PORT = Number(process.env.TRELLIS_NEXT_PORT) || PORT + 99;
const NEXT_UP = `http://127.0.0.1:${NEXT_PORT}`;

if (!hasTtyd()) {
  console.warn(`[trellis] ${TTYD_HOST_DEPENDENCY_NOTE}`);
}

// 转发给上游时**必须换掉 Host**（S79 花了很久才钉死的一个坑）。
//
// 症状：从开发 shell 里起的实例，`/` 和 `/login` 全部超时无响应，而直接打
// 内部 Next 端口一切正常；大门自己的 /__gate/health 也正常。日志显示一次
// curl 打进来会触发**几百次** fetch handler 调用，user-agent 全是 curl。
//
// 机制：环境里存在 http_proxy 时（本机 clash 会塞 127.0.0.1:7897），bun 的
// fetch 按**请求头里的 Host** 而不是 URL 的 authority 去决定连谁 —— 于是
// `Host: 127.0.0.1:3088` 让大门把请求发回了自己，自我循环直到超时。实测隔离
// 到单个请求头：只带 host → 超时，去掉 host 的全套真实请求头 → 200。
//
// prod 至今没炸只是因为 launchd 不继承 shell 环境（没有 http_proxy）——
// 换句话说这是个**潜伏的坑**，不是本次改动引入的（HEAD~1 的大门实测同样中招）。
// 进程内 delete process.env.http_proxy 没用，bun 在用户代码跑之前就把代理
// 配置定死了。所以修在请求头这一侧，顺带也是反向代理本来就该有的行为。
//
// 原始 Host 走 x-forwarded-host 传下去，别让 Next 丢掉「用户是从哪个域名来的」
// —— 公网隧道下 /login 的重定向要靠它拼绝对地址（见 proxy.ts）。
function upstreamHeaders(h: Headers, upstreamHost: string): Headers {
  const out = new Headers(h);
  const original = h.get("host");
  if (original && !h.has("x-forwarded-host")) {
    out.set("x-forwarded-host", original);
  }
  out.set("host", upstreamHost);
  return out;
}

// 与 proxy.ts 同一套判据：两个变量任一缺失 = 闸关（本地开发免摩擦）。
// /term 不走 Next，所以 proxy.ts 那个 middleware 管不到它，闸得在这里自己把。
const PASS = process.env.TRELLIS_AUTH_PASS;
const TOKEN = process.env.TRELLIS_AUTH_TOKEN;
const gateOn = Boolean(PASS && TOKEN);

function authed(req: Request): boolean {
  if (!gateOn) return true;
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === AUTH_COOKIE) return v.join("=") === TOKEN;
  }
  return false;
}

// ── Next 子进程 ────────────────────────────────────────────────────────────
//
// 大门比 Next 活得久（S79）。原本 Next 一挂大门就 `process.exit(1)`，靠
// launchd 的 KeepAlive 拉起来 —— 而 plist 没有 ThrottleInterval，坏版本会被
// 无限 respawn，浏览器侧只剩 connection refused，看不到任何原因。现在改成：
// 大门先占住端口，Next 自己带退避重启，起不来就出维护页说人话。
let nextProc: Subprocess | null = null;
let nextReady = false;
let consecutiveFailures = 0;
let lastExitCode: number | null = null;
let shuttingDown = false;

// 一次性口令，只下发给自己 spawn 的 Next —— 排空钩子
// （app/api/internal/shutdown）靠它认人。
const SHUTDOWN_TOKEN = crypto.randomUUID();

async function portOpen(port: number): Promise<boolean> {
  try {
    const sock = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: { data() {} },
    });
    sock.end();
    return true;
  } catch {
    return false;
  }
}

async function waitFor(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await Bun.sleep(200);
  }
  return false;
}

/** spawn 一次 Next 并等它监听。返回是否起来了。 */
async function bootNext(): Promise<boolean> {
  nextProc = spawn({
    cmd: ["bun", "--bun", "node_modules/.bin/next", "start", "-p", String(NEXT_PORT), "-H", "127.0.0.1"],
    env: {
      ...process.env,
      PORT: String(NEXT_PORT),
      TRELLIS_SHUTDOWN_TOKEN: SHUTDOWN_TOKEN,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  // 和「子进程直接退出」赛跑。只等端口的话，启动即崩的 Next（比如 .next 不存在）
  // 也要干等满 60s 才被判失败 —— 那 60s 里维护页会一直说「正在启动」，退避重启
  // 也压根没开始。实测这种崩溃 1s 内就退出了。
  const proc = nextProc;
  const listened = await Promise.race([
    waitFor(NEXT_PORT, 60_000),
    proc.exited.then(() => false),
  ]);
  if (listened) return true;
  lastExitCode = proc.exitCode;
  console.error(
    proc.exitCode !== null
      ? `[trellis] next exited during startup (code=${proc.exitCode})`
      : `[trellis] next did not listen on ${NEXT_PORT} within 60s`,
  );
  try {
    proc.kill();
  } catch {
    /* 已经没了 */
  }
  return false;
}

// 起不来就退避重试，永不放弃 —— launchd 重启一遍也是同样的结果，还会把大门
// 一起带走（连维护页都没了）。指数退避封顶 30s。
async function superviseNext(): Promise<void> {
  let backoff = 1000;
  while (!shuttingDown) {
    const startedAt = Date.now();
    if (await bootNext()) {
      nextReady = true;
      consecutiveFailures = 0;
      // 新的 Next = ttyd 可能落在别的端口上，作废缓存（见 resolveTtydPort）。
      ttydPort = null;
      console.log(`[trellis] next ready on 127.0.0.1:${NEXT_PORT}`);
      await nextProc!.exited;
      nextReady = false;
      if (shuttingDown) return;
      lastExitCode = nextProc?.exitCode ?? null;
      console.error(`[trellis] next exited (code=${lastExitCode}) — restarting`);
      // 之前活够久 = 偶发崩溃，别背着上一轮的退避惩罚。
      if (Date.now() - startedAt > 60_000) backoff = 1000;
    } else {
      consecutiveFailures++;
    }
    if (shuttingDown) return;
    await Bun.sleep(backoff);
    backoff = Math.min(30_000, backoff * 2);
  }
}

// 优雅停机：先让 Next 排空（abort 在跑的 run、收走 ttyd），再 kill。
// 不排空的话，spawn 出去的 claude/codex 会 reparent 到 launchd 继续跑、继续
// 写 jsonl、继续烧 token，DB 里那行还卡在 streaming。
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (nextReady) {
    try {
      await fetch(`${NEXT_UP}/api/internal/shutdown`, {
        method: "POST",
        headers: {
          "x-trellis-shutdown": SHUTDOWN_TOKEN,
          // 这条路由同样盖在 proxy.ts 的 cookie 闸下面。大门手里就有 TOKEN。
          ...(gateOn ? { cookie: `${AUTH_COOKIE}=${TOKEN}` } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      /* 排空是尽力而为，超时/失败照样往下走 kill */
    }
  }
  try {
    nextProc?.kill();
  } catch {
    /* 已经没了 */
  }
  await Promise.race([
    nextProc?.exited ?? Promise.resolve(0),
    Bun.sleep(3000),
  ]);
  process.exit(0);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void shutdown();
  });
}

// ── ttyd 端口发现 ──────────────────────────────────────────────────────────
// ttyd 的生命周期归 lib/server/ttyd.ts（跑在 Next 进程里，懒启动）。大门这边
// 只需要知道它监听在哪 —— 通过 Next 的内部接口问一次，缓存住；ttyd 重启换端口
// 时下一次 /term 请求会重新问。
let ttydPort: number | null = null;
async function resolveTtydPort(cookie: string): Promise<number | null> {
  if (ttydPort && (await portOpen(ttydPort))) return ttydPort;
  try {
    // 带上调用方那份 cookie —— 那条内部接口同样盖在 proxy.ts 的闸下面，
    // 而我们在调这里之前已经 authed(req) 过了。这样闸上不用开任何
    // 「内部 header 免验」的口子（那种口子外部可以伪造）。
    const r = await fetch(`${NEXT_UP}/api/terminals/port`, {
      headers: cookie ? { cookie } : {},
    });
    if (!r.ok) return null;
    const d = (await r.json()) as { port: number | null };
    ttydPort = d.port ?? null;
  } catch {
    ttydPort = null;
  }
  return ttydPort;
}

// bun 的 fetch **会自动解压**上游响应（而且它自己会加 Accept-Encoding，
// 所以哪怕客户端没要压缩、上游也可能返回 gzip）。若把原样的响应头贴回去，
// 客户端拿到的就是「声称是 gzip 的明文」+ 一个对不上的 Content-Length ——
// curl 默认不解压所以看着没事，**浏览器当场卡死**（这个 bug 差点上 prod）。
// 这三个描述传输编码的头必须由我们这层重新生成，不能透传。
function passthroughHeaders(h: Headers): Headers {
  const out = new Headers(h);
  out.delete("content-encoding");
  out.delete("content-length");
  out.delete("transfer-encoding");
  return out;
}

// ── 维护页 ─────────────────────────────────────────────────────────────────
// Next 没就绪时的门面。要点：**未认证的访客只看得到「正在更新」**，sha /
// 日志 / 路径只在带着有效 cookie 时才渲染 —— 这台机器挂着公网隧道，stderr
// 里什么都有。
function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

function nextStatus(): "ready" | "starting" | "down" {
  if (nextReady) return "ready";
  return consecutiveFailures > 0 ? "down" : "starting";
}

function maintenancePage(detailed: boolean): Response {
  const st = readDeployState();
  const status = nextStatus();
  // 只有「正在进行中的部署」才有资格解释当前的不可用。判据提到 deploy-state.ts
  // 共享 —— 设置页的「能不能再发一次更新」问的是同一个问题，两处不能各判各的。
  const fresh = isDeployStateFresh(st);
  const headline =
    fresh && st.phase !== "done" && st.phase !== "idle"
      ? { preflight: "正在检查", stage: "正在准备新版本", install: "正在安装依赖", build: "正在构建", smoke: "正在预检新版本", backup: "正在备份数据库", switch: "正在切换版本", verify: "正在验活", rollback: "正在回滚", failed: "本次更新失败", broken: "更新失败且回滚未成功", done: "", idle: "" }[st.phase] ?? "正在更新"
      : status === "down"
        ? "服务启动失败"
        : "服务正在启动";

  const detail = detailed
    ? `
    <dl>
      <dt>网关</dt><dd>up · :${PORT}</dd>
      <dt>Next</dt><dd>${status}${consecutiveFailures ? ` · 连续失败 ${consecutiveFailures} 次` : ""}${lastExitCode !== null ? ` · 上次退出码 ${lastExitCode}` : ""}</dd>
      ${st ? `<dt>部署阶段</dt><dd>${esc(st.phase)} · ${esc(st.message)}</dd>` : ""}
      ${st?.sha ? `<dt>目标版本</dt><dd><code>${esc(st.sha)}</code></dd>` : ""}
      ${st?.previousSha ? `<dt>回滚目标</dt><dd><code>${esc(st.previousSha)}</code></dd>` : ""}
    </dl>
    <p class="hint">回滚命令：<code>${esc(deployPaths().bin)}/rollback.sh</code></p>
    ${(() => {
      const t = tailLog(st?.logFile ?? null);
      return t ? `<pre>${esc(t)}</pre>` : "";
    })()}`
    : `<p class="hint">服务恢复后本页会自动刷新。</p>`;

  return new Response(
    `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>trellis · ${esc(headline)}</title>
<meta http-equiv="refresh" content="5">
<style>
:root{color-scheme:dark light}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e6e8ec;
     font:15px/1.6 ui-sans-serif,-apple-system,"PingFang SC",system-ui,sans-serif}
main{max-width:760px;padding:32px}
h1{font-size:20px;margin:0 0 4px}
.sub{color:#8b93a1;margin:0 0 20px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0 0 16px}
dt{color:#8b93a1}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:#161a21;border:1px solid #232936;border-radius:8px;padding:12px;overflow:auto;
    max-height:320px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#c3cad6}
.hint{color:#8b93a1;font-size:13px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#e0a03a;margin-right:8px;
     animation:p 1.4s ease-in-out infinite}
@keyframes p{50%{opacity:.25}}
</style></head><body><main>
<h1><span class="dot"></span>${esc(headline)}</h1>
<p class="sub">trellis 暂时不可用，网关还在。</p>
${detail}
</main></body></html>`,
    {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "retry-after": "5",
        "cache-control": "no-store",
      },
    },
  );
}

// ── 大门 ───────────────────────────────────────────────────────────────────
// 注意顺序：**先占端口再拉 Next**。反过来的话，Next 起不来的那 60s 里外面
// 连的是一个不存在的端口（connection refused），维护页根本没机会出现。
void superviseNext();

// 每条 WS 连接随身带的上下文：目标 ttyd 端口 / 路径，以及上游连接与
// 「上游还没连上时」的待发队列。
type TermSocket = {
  port: number;
  path: string;
  search: string;
  up?: WebSocket;
  q: (string | Uint8Array)[];
};

Bun.serve<TermSocket>({
  port: PORT,
  // SSE / 长连接不能被空闲超时掐死。trellis 的一轮生成可以几分钟不吐字节
  // （思考期），默认 idleTimeout 会当场断流。
  idleTimeout: 0,
  async fetch(req, server) {
    const url = new URL(req.url);

    // 网关自己的健康面。**不经 Next**，所以 Next 挂着的时候它照样准确 ——
    // 部署脚本的 verify 和 daily-health 都指望这一条。粗粒度状态对谁都公开
    // （它就是「服务活没活」，不含任何内部信息），版本详情要认证。
    if (url.pathname === "/__gate/health") {
      const body: Record<string, unknown> = {
        gate: "up",
        next: nextStatus(),
        consecutiveFailures,
        // 认证闸开没开。不是秘密（一个 401 就暴露了），但部署流水线要靠它做
        // 「切换前后闸状态不许 on→off」的断言 —— 凭证来自 .env.local 这类
        // 未跟踪文件，一旦没被带进 release，闸会静默关掉。
        auth: gateOn ? "on" : "off",
      };
      if (authed(req)) {
        const st = readDeployState();
        body.deploy = st ? { phase: st.phase, sha: st.sha } : null;
        body.release = readReleaseInfo(deployPaths().current);
        body.lastExitCode = lastExitCode;
      }
      return Response.json(body, {
        headers: { "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/term" || url.pathname.startsWith("/term/")) {
      if (!authed(req)) return new Response("Unauthorized", { status: 401 });
      // /term 的端口发现要问 Next，Next 不在就没得问。
      if (!nextReady) return maintenancePage(authed(req));
      const port = await resolveTtydPort(req.headers.get("cookie") ?? "");
      if (!port) {
        return new Response("终端未就绪（ttyd 未启动）", { status: 503 });
      }
      // ttyd 挂在自己的根路径下，把 /term 前缀剥掉再转发。
      const path = url.pathname.replace(/^\/term/, "") || "/";

      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (server.upgrade(req, { data: { port, path, search: url.search, q: [] } })) {
          return undefined;
        }
        return new Response("upgrade failed", { status: 400 });
      }

      const r = await fetch(`http://127.0.0.1:${port}${path}${url.search}`, {
        method: req.method,
        headers: upstreamHeaders(req.headers, `127.0.0.1:${port}`),
        body: req.body,
        redirect: "manual",
        // @ts-expect-error bun 需要 duplex 才能流式转发请求体
        duplex: "half",
      });
      return new Response(r.body, {
        status: r.status,
        headers: passthroughHeaders(r.headers),
      });
    }

    if (!nextReady) return maintenancePage(authed(req));

    try {
      const r = await fetch(`${NEXT_UP}${url.pathname}${url.search}`, {
        method: req.method,
        headers: upstreamHeaders(req.headers, `127.0.0.1:${NEXT_PORT}`),
        body: req.body,
        redirect: "manual",
        // @ts-expect-error bun 需要 duplex 才能流式转发请求体
        duplex: "half",
      });
      return new Response(r.body, {
        status: r.status,
        headers: passthroughHeaders(r.headers),
      });
    } catch {
      // Next 正好在这一刻死了（nextReady 还没翻）——别把裸 500 丢给用户。
      return maintenancePage(authed(req));
    }
  },

  // 消息级 WS 转发（不是字节级）：ttyd 的协议就是普通的二进制/文本帧，
  // 逐帧转发即可。上游还没连上时先把客户端的帧排队，连上再补发 ——
  // ttyd 客户端一 open 就发 AuthToken，丢了它整条连接就废。
  websocket: {
    idleTimeout: 0,
    open(ws) {
      const d = ws.data;
      const up = new WebSocket(
        `ws://127.0.0.1:${d.port}${d.path}${d.search}`,
        ["tty"],
      );
      up.binaryType = "arraybuffer";
      d.up = up;
      up.onopen = () => {
        for (const m of d.q) up.send(m);
        d.q.length = 0;
      };
      up.onmessage = (e) =>
        ws.send(
          e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : e.data,
        );
      up.onclose = () => ws.close();
      up.onerror = () => ws.close();
    },
    message(ws, msg) {
      const d = ws.data;
      if (d.up && d.up.readyState === 1) d.up.send(msg);
      else d.q.push(msg as string | Uint8Array);
    },
    close(ws) {
      try {
        ws.data.up?.close();
      } catch {
        /* 已经关了 */
      }
    },
  },
});

console.log(
  `[trellis] gate listening on :${PORT}  (auth ${gateOn ? "ON" : "OFF"}, next→${NEXT_PORT})`,
);
