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
let nextProc: Subprocess | null = null;

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

async function startNext() {
  nextProc = spawn({
    cmd: ["bun", "--bun", "node_modules/.bin/next", "start", "-p", String(NEXT_PORT), "-H", "127.0.0.1"],
    env: { ...process.env, PORT: String(NEXT_PORT) },
    stdout: "inherit",
    stderr: "inherit",
    // Next 挂了整个 trellis 就没了，别装作还活着 —— 直接退出让 launchd 拉起来。
    onExit(_p, code) {
      console.error(`[trellis] next exited (code=${code}) — shutting down gate`);
      process.exit(code ?? 1);
    },
  });
  if (!(await waitFor(NEXT_PORT, 60_000))) {
    console.error(`[trellis] next did not listen on ${NEXT_PORT} within 60s`);
    process.exit(1);
  }
  console.log(`[trellis] next ready on 127.0.0.1:${NEXT_PORT}`);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    try {
      nextProc?.kill();
    } catch {
      /* 已经没了 */
    }
    process.exit(0);
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

// ── 大门 ───────────────────────────────────────────────────────────────────
await startNext();

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

    if (url.pathname === "/term" || url.pathname.startsWith("/term/")) {
      if (!authed(req)) return new Response("Unauthorized", { status: 401 });
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
        headers: req.headers,
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

    const r = await fetch(`${NEXT_UP}${url.pathname}${url.search}`, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: "manual",
      // @ts-expect-error bun 需要 duplex 才能流式转发请求体
      duplex: "half",
    });
    return new Response(r.body, {
      status: r.status,
      headers: passthroughHeaders(r.headers),
    });
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
