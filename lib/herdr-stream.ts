// herdr 实时终端流：大门（server.ts）里的 /herdr-stream WebSocket 端点。
//
// 为什么在大门而不在 Next：App Router 升级不了 WS（server.ts 文件头有实测记录）。
// 所以这个模块跑在大门的纯 bun 进程里，**不许 import 任何 server-only 模块**——
// herdr 的 JSON-RPC 在这里自己写了一个最小版本，socket 定位和 Next 侧共用
// lib/herdr-socket-path。Next 没就绪时流照样能用（它不依赖 Next）。
//
//   浏览器 ══WS══ 大门 ──spawn── herdr terminal session observe <pane> --cols C --rows R
//                   │                  （stdout NDJSON 帧 → 解码 → 合帧 → 二进制 WS 帧）
//                   └──unix socket── pane.send_text / send_keys / scroll / get ...
//
// 只观察：永远不调 terminal session control / pane.resize，真实窗格的尺寸一个像素都不动。
// observe 按「真实窗格的尺寸」开（它是裁剪不是重排，见 herdr-stream-protocol 文件头）。

import { spawn, type ServerWebSocket, type Subprocess } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHerdrSocketPath } from "./herdr-socket-path";
import { isHerdrProtocolSupported } from "./server/herdr-types";
import {
  BACKPRESSURE_HIGH,
  CLOSE_PANE_GONE,
  CLOSE_TOO_MANY,
  CLOSE_UNSUPPORTED,
  FrameCoalescer,
  LineSplitter,
  MAX_STREAMS,
  backpressureAction,
  clampGrid,
  parseClientMessage,
  parseObserveLine,
  parseStreamParams,
  preparePaste,
  splitInput,
  type HerdrInputSegment,
  type HerdrStreamServerMessage,
} from "./herdr-stream-protocol";

export type HerdrStreamSocketData = {
  kind: "herdr";
  paneId: string;
  hint: { cols: number; rows: number } | null;
  stream?: HerdrStream;
};

/** 合帧窗口：距上次发送不足这么久的帧先攒着。安静之后的第一帧立即发，打字回显不被拖慢。 */
const COALESCE_MS = 24;
/** 攒到这么大就不等窗口，立即发。 */
const COALESCE_FLUSH_BYTES = 512 * 1024;
// 真实窗格尺寸什么时候重查：实测真实窗格被分屏 / 合并时，observe 会**自己**再吐一帧
// full（同一个子进程的第 2、3… 个 full 帧），这就是最准的「尺寸可能变了」信号，零额外开销。
// 兜底再每 15 秒查一次（防 herdr 某个版本不吐这帧），比原来每 2 秒 spawn 一次 stty 省得多。
const GEOMETRY_POLL_MS = 15_000;
/** 收到 full 帧后稍等再查：拖分割线时会连吐好几帧 full，合并成一次。 */
const GEOMETRY_DEBOUNCE_MS = 150;
/** 滚轮控制连接闲置多久释放。挂着期间真实窗格若被用户改尺寸，control 可能按旧尺寸拉回去，所以要短。 */
const WHEEL_IDLE_MS = 1_500;
/** 滚完多久回报一次 herdr 的滚动位置（翻的是 herdr 自己的历史时，浏览器靠它知道「不在底部」）。 */
const WHEEL_REPORT_MS = 150;
const RPC_TIMEOUT_MS = 5_000;
/** 每连接排队中的输入上限。超了说明 herdr 卡住了，拒收比无限堆积好。 */
const INPUT_QUEUE_MAX = 64;
/** observe 的 stderr 只留前这么多，够拼报错就行。 */
const STDERR_KEEP = 4096;

// ── herdr 可执行文件 ───────────────────────────────────────────────────────
// launchd 起的大门 PATH 很短，~/.local/bin 往往不在里面，所以和 ttyd 一样按候选找。
let herdrBinCache: string | null | undefined;
function herdrBin(): string | null {
  if (herdrBinCache !== undefined) return herdrBinCache;
  const home = process.env.HOME || os.homedir();
  const candidates = [
    process.env.TRELLIS_HERDR_BIN,
    path.join(home, ".local", "bin", "herdr"),
    "/opt/homebrew/bin/herdr",
    "/usr/local/bin/herdr",
    "/usr/bin/herdr",
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, "herdr")),
  ].filter((p): p is string => Boolean(p));
  herdrBinCache = null;
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      if (fs.statSync(c).isFile()) {
        herdrBinCache = c;
        break;
      }
    } catch {
      /* 下一个 */
    }
  }
  return herdrBinCache;
}

export function herdrStreamEnabled(): boolean {
  return process.env.TRELLIS_HERDR !== "off";
}

// ── 最小 JSON-RPC ─────────────────────────────────────────────────────────
// 每次调用一条短连接、换行分隔 JSON（与 lib/server/herdr-client 的 requestOnce 同一协议）。

class RpcError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

function rpc<T>(method: string, params: Record<string, unknown>, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
  const socketPath = resolveHerdrSocketPath();
  return new Promise<T>((resolve, reject) => {
    let buffer = "";
    const decoder = new TextDecoder();
    let settled = false;
    let socket: { end(): void } | null = null;
    const finish = (error: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.end();
      } catch {
        /* 已经关了 */
      }
      if (error) reject(error);
      else resolve(value as T);
    };
    const timer = setTimeout(() => finish(new RpcError(`${method} timed out`, "ETIMEDOUT")), timeoutMs);
    Bun.connect({
      unix: socketPath,
      socket: {
        open(s) {
          socket = s;
          s.write(`${JSON.stringify({ id: "1", method, params })}\n`);
        },
        data(_s, chunk) {
          buffer += decoder.decode(chunk, { stream: true });
          const nl = buffer.indexOf("\n");
          if (nl < 0) return;
          try {
            const res = JSON.parse(buffer.slice(0, nl)) as
              | { result: T }
              | { error: { code: string; message: string } };
            if ("error" in res) finish(new RpcError(res.error.message, res.error.code));
            else finish(null, res.result);
          } catch (e) {
            finish(new RpcError(`invalid ${method} response: ${e}`, "EPROTO"));
          }
        },
        error(_s, e) {
          finish(new RpcError(String(e), "SOCKET_ERROR"));
        },
        close() {
          finish(new RpcError(`${method} closed without response`, "EOF"));
        },
      },
    }).catch((e) => finish(new RpcError(String(e), "ECONNREFUSED")));
  });
}

// ── 真实窗格尺寸 ──────────────────────────────────────────────────────────
// herdr 的 API 里没有「窗格 PTY 有几列」这个字段：pane.get 的 scroll.viewport_rows 是
// 行数，pane.layout 的 rect 含边框（实测分屏后 rect 107×55 而 PTY 是 104×53；单窗格
// 无边框时两者相等）。最准的是直接问 PTY 本身：shell_pid → 控制终端 → stty size
// （TIOCGWINSZ，只读，不改任何东西）。拿不到再退回 layout 估算。

type Grid = { cols: number; rows: number };

// 异步跑：同步 spawn 会让整个大门（含 SSE 转发）跟着卡几毫秒。
async function run(cmd: string[]): Promise<string | null> {
  try {
    const p = spawn({ cmd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return code === 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

async function ttyOfPid(pid: number): Promise<string | null> {
  const tty = await run(["ps", "-o", "tty=", "-p", String(pid)]);
  return tty && /^(tty|pts\/)[\w/]+$/.test(tty) ? `/dev/${tty}` : null;
}

async function sttySize(ttyPath: string): Promise<Grid | null> {
  const flag = process.platform === "darwin" ? "-f" : "-F";
  const m = /^(\d+)\s+(\d+)/.exec((await run(["stty", flag, ttyPath, "size"])) ?? "");
  if (!m) return null;
  const rows = Number(m[1]);
  const cols = Number(m[2]);
  return rows > 0 && cols > 0 ? { cols, rows } : null;
}

async function layoutEstimate(paneId: string): Promise<Grid | null> {
  try {
    const [layout, info] = await Promise.all([
      rpc<{ layout: { panes: { pane_id: string; rect: { width: number; height: number } }[] } }>("pane.layout", { pane_id: paneId }),
      rpc<{ pane: { scroll?: { viewport_rows?: number } } }>("pane.get", { pane_id: paneId }),
    ]);
    const rect = layout.layout.panes.find((p) => p.pane_id === paneId)?.rect;
    const rows = info.pane.scroll?.viewport_rows;
    if (!rect || !rows) return null;
    // 有边框时左右共 3 列（实测 107→104、106→103），无边框时 rect 就是 PTY。
    return { cols: rect.height > rows ? rect.width - 3 : rect.width, rows };
  } catch {
    return null;
  }
}

// ── 连接注册表（并发上限、停机清理）─────────────────────────────────────────

const live = new Set<HerdrStream>();

/** 大门停机时调用：杀掉所有 observe 子进程。 */
export function closeAllHerdrStreams(): void {
  for (const s of [...live]) s.dispose("server shutting down", 1001);
}

// 大门被直接 kill（不走 shutdown）时也别留下孤儿 observe。exit 钩子里只能同步。
process.on("exit", () => {
  for (const s of live) s.killChildSync();
});

// ── 单条连接 ──────────────────────────────────────────────────────────────

export class HerdrStream {
  private child: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  /** 每开一次 observe +1；旧子进程的输出和退出事件按代号丢弃。 */
  private generation = 0;
  private grid: Grid;
  private gridSource: "pane" | "client";
  private tty: string | null | undefined;
  private readonly coalescer = new FrameCoalescer();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSendAt = 0;
  private stalled = false;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private geometryTimer: ReturnType<typeof setInterval> | null = null;
  private geometryDebounce: ReturnType<typeof setTimeout> | null = null;
  private inputTail: Promise<void> = Promise.resolve();
  private inputDepth = 0;
  private pendingScroll: number | null = null;
  private scrolling = false;
  /** herdr 最近一次回报的滚动位置（离底部几行），滚轮回退到 pane.scroll 时从这里累加。 */
  private lastOffset = 0;
  private wheel: { child: Subprocess<"pipe", "ignore", "ignore">; cols: number; rows: number } | null = null;
  private wheelIdle: ReturnType<typeof setTimeout> | null = null;
  private wheelReport: ReturnType<typeof setTimeout> | null = null;
  /** control 起不来（herdr 太旧 / 被拒）就不再试，滚轮退回 pane.scroll。 */
  private wheelBroken = false;
  private readOnly = false;
  private disposed = false;

  constructor(
    private readonly ws: ServerWebSocket<HerdrStreamSocketData>,
    private readonly paneId: string,
    hint: Grid | null,
  ) {
    this.grid = hint ?? { cols: 80, rows: 24 };
    this.gridSource = "client";
    live.add(this);
  }

  private send(msg: HerdrStreamServerMessage): void {
    if (this.disposed) return;
    this.ws.send(JSON.stringify(msg));
  }

  async start(): Promise<void> {
    const bin = herdrBin();
    if (!bin) {
      this.send({ t: "error", code: "unsupported", message: "大门找不到 herdr 可执行文件（可设 TRELLIS_HERDR_BIN）" });
      this.dispose("herdr not found", CLOSE_UNSUPPORTED);
      return;
    }
    try {
      const pong = await rpc<{ protocol: number }>("ping", {});
      // 协议版本超出 trellis 认可的范围时，与 Next 侧一致：照看，但不写。
      this.readOnly = !isHerdrProtocolSupported(pong.protocol);
      await rpc("pane.get", { pane_id: this.paneId });
    } catch (e) {
      if (this.disposed) return;
      if (e instanceof RpcError && e.code === "pane_not_found") {
        this.send({ t: "error", code: "pane_not_found", message: "窗格已关闭" });
        this.dispose("pane not found", CLOSE_PANE_GONE);
      } else {
        this.send({ t: "error", code: "unavailable", message: `herdr 不可用：${e instanceof Error ? e.message : e}` });
        this.dispose("herdr unavailable", 1011);
      }
      return;
    }
    if (this.disposed) return;
    await this.refreshGeometry();
    if (this.disposed) return;
    this.send({ t: "ready", readOnly: this.readOnly });
    this.startObserve();
    this.geometryTimer = setInterval(() => this.checkGeometry(), GEOMETRY_POLL_MS);
  }

  /** 重查尺寸，变了就按新网格重开 observe。 */
  private checkGeometry(): void {
    if (this.geometryDebounce) clearTimeout(this.geometryDebounce);
    this.geometryDebounce = null;
    void this.refreshGeometry().then((changed) => {
      // 尺寸变了：滚轮控制连接是按旧尺寸挂的，立刻放掉，免得它把窗格拉回旧尺寸。
      if (changed) this.releaseWheel();
      if (changed && !this.stalled && !this.disposed) this.startObserve();
    });
  }

  private scheduleGeometryCheck(): void {
    if (this.geometryDebounce || this.disposed) return;
    this.geometryDebounce = setTimeout(() => this.checkGeometry(), GEOMETRY_DEBOUNCE_MS);
  }

  /** 重新查真实窗格尺寸；变了返回 true。查不到就保留现有网格（浏览器给的兜底）。 */
  private async refreshGeometry(): Promise<boolean> {
    let next: Grid | null = null;
    try {
      if (this.tty === undefined) {
        const info = await rpc<{ process_info: { shell_pid?: number } }>("pane.process_info", { pane_id: this.paneId });
        const pid = info.process_info.shell_pid;
        this.tty = pid ? await ttyOfPid(pid) : null;
      }
      if (this.tty) next = await sttySize(this.tty);
      // stty 失败多半是 shell 换了（窗格重启），下次重新找 tty。
      if (this.tty && !next) this.tty = undefined;
    } catch {
      this.tty = undefined;
    }
    next ??= await layoutEstimate(this.paneId);
    if (!next) return false;
    const g = clampGrid(next.cols, next.rows);
    const changed = g.cols !== this.grid.cols || g.rows !== this.grid.rows || this.gridSource !== "pane";
    this.grid = g;
    this.gridSource = "pane";
    return changed;
  }

  /** 浏览器给的兜底尺寸：只有一直没查到真实尺寸时才采用。 */
  clientResize(cols: number, rows: number): void {
    if (this.gridSource === "pane") return;
    if (cols === this.grid.cols && rows === this.grid.rows) return;
    this.grid = { cols, rows };
    if (!this.stalled) this.startObserve();
  }

  private startObserve(): void {
    this.killChild();
    if (this.disposed) return;
    const bin = herdrBin();
    if (!bin) return;
    const gen = ++this.generation;
    const { cols, rows } = this.grid;
    let child: Subprocess<"ignore", "pipe", "pipe">;
    try {
      child = spawn({
        cmd: [bin, "terminal", "session", "observe", this.paneId, "--cols", String(cols), "--rows", String(rows)],
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (e) {
      this.send({ t: "error", code: "unsupported", message: `启动 observe 失败：${e}` });
      this.dispose("spawn failed", CLOSE_UNSUPPORTED);
      return;
    }
    this.child = child;
    // 新子进程的第一帧必是 full：先告诉浏览器网格，它 resize 完再写。
    this.send({ t: "size", cols, rows, source: this.gridSource });
    let frames = 0;
    let closedReason: string | null = null;
    let stderr = "";
    void (async () => {
      const reader = child.stderr.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (stderr.length < STDERR_KEEP) stderr += dec.decode(value, { stream: true });
      }
    })().catch(() => {});
    void (async () => {
      const splitter = new LineSplitter();
      const reader = child.stdout.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done || gen !== this.generation) break;
        for (const line of splitter.push(value)) {
          const ev = parseObserveLine(line);
          if (!ev) continue;
          if (ev.kind === "closed") closedReason = ev.reason;
          else {
            frames++;
            // 第一帧 full 是开流自带的；之后再来 full = 真实窗格多半变了尺寸。
            if (ev.full && frames > 1) this.scheduleGeometryCheck();
            this.onFrame(ev);
          }
        }
      }
    })()
      .catch(() => {})
      .finally(() => {
        void child.exited.then((code) => {
          if (gen !== this.generation || this.disposed) return;
          this.child = null;
          this.onObserveEnded(code, frames, closedReason, stderr.trim());
        });
      });
  }

  private onObserveEnded(code: number | null, frames: number, closedReason: string | null, stderr: string): void {
    this.flush();
    const reason = closedReason ?? (stderr || `observe exited (code=${code})`);
    if (/not found/i.test(reason)) {
      this.send({ t: "exit", reason: "窗格已关闭" });
      this.dispose("pane closed", CLOSE_PANE_GONE);
      return;
    }
    // 一帧没出就以非零码退出、也没有 terminal.closed：这版 herdr 没有 observe 子命令
    // （clap 报 unrecognized subcommand）之类。重连也没用，让浏览器回退轮询。
    if (frames === 0 && closedReason === null && code !== 0) {
      this.send({ t: "error", code: "unsupported", message: `herdr 不支持实时观察：${reason.slice(0, 300)}` });
      this.dispose("observe unsupported", CLOSE_UNSUPPORTED);
      return;
    }
    this.send({ t: "exit", reason });
    this.dispose("observe ended", 1011);
  }

  private onFrame(frame: Parameters<FrameCoalescer["push"]>[0]): void {
    if (this.stalled || this.disposed) return;
    this.coalescer.push(frame);
    if (this.coalescer.bytes >= COALESCE_FLUSH_BYTES) {
      this.flush();
      return;
    }
    if (this.flushTimer) return;
    const wait = COALESCE_MS - (Date.now() - this.lastSendAt);
    if (wait <= 0) this.flush();
    else this.flushTimer = setTimeout(() => this.flush(), wait);
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.disposed || this.coalescer.empty) return;
    const action = backpressureAction(this.ws.getBufferedAmount(), this.stalled);
    if (action === "stall") {
      this.stall();
      return;
    }
    if (action !== "send") return;
    const out = this.coalescer.take();
    if (!out) return;
    this.lastSendAt = Date.now();
    this.ws.send(out.bytes);
    if (this.ws.getBufferedAmount() > BACKPRESSURE_HIGH) this.stall();
  }

  // 停流：杀 observe、丢弃待发；等缓冲排空再重开（新子进程的 full 帧会把屏幕刷对）。
  private stall(): void {
    if (this.stalled) return;
    this.stalled = true;
    console.warn(`[trellis] herdr-stream ${this.paneId}: 浏览器读不动（缓冲 ${this.ws.getBufferedAmount()} B），停流`);
    this.coalescer.clear();
    this.killChild();
    this.drainTimer = setInterval(() => this.onDrain(), 250);
  }

  /** WS 发送缓冲有进展时（bun 的 drain 回调或兜底定时器）检查能否恢复。 */
  onDrain(): void {
    if (!this.stalled || this.disposed) return;
    if (backpressureAction(this.ws.getBufferedAmount(), true) !== "resume") return;
    this.stalled = false;
    console.info(`[trellis] herdr-stream ${this.paneId}: 缓冲已排空，重开 observe`);
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = null;
    this.startObserve();
  }

  // ── 浏览器消息 ─────────────────────────────────────────────────────────

  onMessage(raw: string | Buffer): void {
    if (this.disposed) return;
    if (typeof raw !== "string") {
      this.send({ t: "error", code: "bad_request", message: "expected text message" });
      return;
    }
    const msg = parseClientMessage(raw);
    if ("error" in msg) {
      this.send({ t: "error", code: "bad_request", message: msg.error });
      return;
    }
    switch (msg.t) {
      case "ping":
        this.send({ t: "pong" });
        return;
      case "resize":
        this.clientResize(msg.cols, msg.rows);
        return;
      case "scroll":
        if (this.refuseWrite()) return;
        this.pendingScroll = msg.offset;
        void this.runScroll();
        return;
      case "wheel":
        if (this.refuseWrite()) return;
        this.onWheel(msg.dir, msg.lines, msg.col, msg.row);
        return;
      case "input":
        this.enqueueInput(splitInput(msg.data));
        return;
      case "paste":
        this.enqueueInput(splitPaste(msg.data));
        return;
      case "key":
        this.enqueueInput([{ keys: [msg.key] }]);
        return;
    }
  }

  private refuseWrite(): boolean {
    if (!this.readOnly) return false;
    this.send({ t: "error", code: "read_only", message: "herdr 协议版本不匹配，终端只读" });
    return true;
  }

  // 输入按到达顺序串行发：两次按键并发打到 herdr，顺序就不保证了。
  private enqueueInput(segs: HerdrInputSegment[]): void {
    if (this.refuseWrite() || segs.length === 0) return;
    if (this.inputDepth >= INPUT_QUEUE_MAX) {
      this.send({ t: "error", code: "input_failed", message: "输入排队过多，这次没发出去" });
      return;
    }
    this.inputDepth++;
    this.inputTail = this.inputTail
      .then(async () => {
        for (const seg of segs) {
          if (this.disposed) return;
          if ("text" in seg) await rpc("pane.send_text", { pane_id: this.paneId, text: seg.text });
          else await rpc("pane.send_keys", { pane_id: this.paneId, keys: seg.keys });
        }
      })
      .catch((e: unknown) => {
        this.send({ t: "error", code: "input_failed", message: `输入没发出去：${e instanceof Error ? e.message : e}` });
      })
      .finally(() => {
        this.inputDepth--;
      });
  }

  // 滚动只保留最新目标：手指一划几十个事件，没必要逐个打到 herdr。
  private async runScroll(): Promise<void> {
    if (this.scrolling) return;
    this.scrolling = true;
    try {
      while (this.pendingScroll !== null && !this.disposed) {
        const offset = this.pendingScroll;
        this.pendingScroll = null;
        await rpc("pane.scroll", { pane_id: this.paneId, offset_from_bottom: offset });
        if (this.pendingScroll !== null) continue;
        // 回报 herdr 实际停在哪（越界会被它夹住），浏览器据此校正累计偏移。
        const info = await rpc<{ pane: { scroll?: { offset_from_bottom: number; max_offset_from_bottom: number } } }>(
          "pane.get",
          { pane_id: this.paneId },
        );
        const s = info.pane.scroll;
        if (s) {
          this.lastOffset = s.offset_from_bottom;
          this.send({ t: "scrolled", offset: s.offset_from_bottom, max: s.max_offset_from_bottom });
        }
      }
    } catch (e) {
      this.send({ t: "error", code: "input_failed", message: `滚动失败：${e instanceof Error ? e.message : e}` });
    } finally {
      this.scrolling = false;
    }
  }

  // ── 清理 ───────────────────────────────────────────────────────────────

  private killChild(): void {
    // 代号先 +1：旧子进程残留的输出和退出事件一律作废。
    this.generation++;
    const c = this.child;
    this.child = null;
    if (!c) return;
    try {
      c.kill();
    } catch {
      /* 已经没了 */
    }
  }

  killChildSync(): void {
    try {
      this.child?.kill("SIGKILL");
    } catch {
      /* 已经没了 */
    }
  }

  // ── 滚轮 ──────────────────────────────────────────────────────────────────
  //
  // 为什么不只用 pane.scroll：它翻的是 herdr 自己存的历史，而 Claude Code / Codex 这类
  // 全屏应用跑在备用屏上，herdr 那边没有历史（实测这些窗格 max_offset_from_bottom 全是
  // 0），一划就到头。原生 herdr 里滚轮能翻，是因为 herdr 按应用开的鼠标模式把滚轮编码
  // 成 `\x1b[<64;…M` 转给应用、让应用自己翻对话；普通 shell 则翻 herdr 的历史。
  //
  // 这个判断只有 herdr 能做（observe 的帧里不带鼠标 / 备用屏模式），而它只在终端客户端
  // 协议里开放：`herdr terminal session control` 的 stdin 收 terminal.scroll 手势。
  // control 连接会把窗格调到它声明的尺寸（不带 --cols/--rows 实测被改成 120×40），
  // 所以必须带上刚查到的真实尺寸——这样等于「按原尺寸重设一次」，实测 PTY 尺寸不变；
  // 查不到真实尺寸时宁可退回 pane.scroll 也不挂 control。

  private onWheel(dir: "up" | "down", lines: number, col: number, row: number): void {
    if (this.wheelBroken || this.gridSource !== "pane") {
      // 退回 pane.scroll：只能翻 herdr 自己的历史，全屏应用里翻不动，但至少 shell 能用。
      const next = Math.max(0, this.lastOffset + (dir === "up" ? lines : -lines));
      this.lastOffset = next;
      this.pendingScroll = next;
      void this.runScroll();
      return;
    }
    const w = this.ensureWheel();
    if (!w) return this.onWheel(dir, lines, col, row);
    const cmd = {
      type: "terminal.scroll",
      direction: dir,
      lines,
      source: "wheel",
      column: Math.min(col, w.cols - 1),
      row: Math.min(row, w.rows - 1),
    };
    try {
      w.child.stdin.write(JSON.stringify(cmd) + "\n");
      w.child.stdin.flush();
    } catch {
      this.releaseWheel();
      return;
    }
    if (this.wheelIdle) clearTimeout(this.wheelIdle);
    this.wheelIdle = setTimeout(() => this.releaseWheel(), WHEEL_IDLE_MS);
    if (this.wheelReport) clearTimeout(this.wheelReport);
    this.wheelReport = setTimeout(() => void this.reportScroll(), WHEEL_REPORT_MS);
  }

  private ensureWheel(): NonNullable<HerdrStream["wheel"]> | null {
    const { cols, rows } = this.grid;
    if (this.wheel && this.wheel.cols === cols && this.wheel.rows === rows) return this.wheel;
    this.releaseWheel();
    const bin = herdrBin();
    if (!bin || this.disposed) return null;
    let child: Subprocess<"pipe", "ignore", "ignore">;
    try {
      child = spawn({
        // 不带 --takeover：别人（Mac 上的 herdr）正在控制时让 herdr 自己裁决，不抢。
        cmd: [bin, "terminal", "session", "control", this.paneId, "--cols", String(cols), "--rows", String(rows)],
        stdin: "pipe",
        // control 的 stdout 也是帧流，显示用的是 observe 那条，这里不要。
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch {
      this.wheelBroken = true;
      return null;
    }
    const startedAt = Date.now();
    const w = { child, cols, rows };
    this.wheel = w;
    void child.exited.then((code) => {
      if (this.wheel === w) this.wheel = null;
      // 一挂上就以非零码退出 = 这版 herdr 不支持 / 被拒，以后别再试。
      if (code !== 0 && Date.now() - startedAt < 1_000) this.wheelBroken = true;
    });
    return w;
  }

  private releaseWheel(): void {
    if (this.wheelIdle) clearTimeout(this.wheelIdle);
    this.wheelIdle = null;
    const w = this.wheel;
    if (!w) return;
    this.wheel = null;
    try {
      w.child.stdin.write(JSON.stringify({ type: "terminal.release" }) + "\n");
      w.child.stdin.end();
    } catch {
      /* 已经没了 */
    }
    // 正常 release 后它自己退出；兜底一秒后强杀，别留孤儿。
    setTimeout(() => {
      try {
        w.child.kill();
      } catch {
        /* 已经退了 */
      }
    }, 1_000);
  }

  private async reportScroll(): Promise<void> {
    this.wheelReport = null;
    if (this.disposed) return;
    try {
      const info = await rpc<{ pane: { scroll?: { offset_from_bottom: number; max_offset_from_bottom: number } } }>(
        "pane.get",
        { pane_id: this.paneId },
      );
      const s = info.pane.scroll;
      if (s) {
        this.lastOffset = s.offset_from_bottom;
        this.send({ t: "scrolled", offset: s.offset_from_bottom, max: s.max_offset_from_bottom });
      }
    } catch {
      /* 回报是尽力而为 */
    }
  }

  /** 关连接 + 杀子进程 + 停所有定时器。幂等；WS 的 close 回调也走这里。 */
  dispose(reason: string, code = 1000): void {
    if (this.disposed) return;
    this.disposed = true;
    live.delete(this);
    this.killChild();
    this.releaseWheel();
    if (this.wheelReport) clearTimeout(this.wheelReport);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.drainTimer) clearInterval(this.drainTimer);
    if (this.geometryTimer) clearInterval(this.geometryTimer);
    if (this.geometryDebounce) clearTimeout(this.geometryDebounce);
    this.coalescer.clear();
    try {
      this.ws.close(code, reason.slice(0, 120));
    } catch {
      /* 已经关了 */
    }
  }
}

function splitPaste(data: string): HerdrInputSegment[] {
  // 粘贴整体走字面字节（方向键序列已被 preparePaste 里的 ␛ 替换掉，不会误拆）。
  return splitInput(preparePaste(data));
}

// ── 大门接入点 ─────────────────────────────────────────────────────────────

/**
 * 同源校验（纵深防御）：cookie 是 SameSite=Strict，跨站页面本来就带不上它；但闸关着
 * （本地 / Tailscale 免密）时没有 cookie 可依赖，任何网页都能对 ws://127.0.0.1 发起
 * 握手、往 agent 里打字。浏览器发起的 WS 一定带 Origin；没有 Origin 的是非浏览器
 * 客户端（hub 网关转发、脚本），交给 cookie 闸判。
 */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return host === req.headers.get("x-forwarded-host") || host === req.headers.get("host");
}

/**
 * /herdr-stream 的 HTTP 入口。非升级的 GET 是给浏览器重连前探测登录态用的（WS 握手
 * 失败时浏览器拿不到 HTTP 状态码，分不清「没登录」和「网络断了」）。
 */
export function handleHerdrStreamRequest(
  req: Request,
  server: { upgrade(req: Request, opts: { data: HerdrStreamSocketData }): boolean },
  authed: boolean,
): Response | undefined {
  if (!authed) return new Response("Unauthorized", { status: 401 });
  if (!sameOrigin(req)) return new Response("Forbidden", { status: 403 });
  const enabled = herdrStreamEnabled();
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return Response.json(
      { ok: true, enabled, streams: live.size, max: MAX_STREAMS },
      { headers: { "cache-control": "no-store" } },
    );
  }
  if (!enabled) return new Response("herdr disabled", { status: 404 });
  const url = new URL(req.url);
  const params = parseStreamParams(url.searchParams);
  if (!params.ok) return new Response(params.error, { status: 400 });
  if (live.size >= MAX_STREAMS) return new Response("too many terminal streams", { status: 503 });
  if (server.upgrade(req, { data: { kind: "herdr", paneId: params.paneId, hint: params.hint } })) return undefined;
  return new Response("upgrade failed", { status: 400 });
}

export const herdrStreamSocket = {
  open(ws: ServerWebSocket<HerdrStreamSocketData>): void {
    // 握手检查和 open 之间可能并发进来多条：这里再卡一次上限。
    if (live.size >= MAX_STREAMS) {
      ws.close(CLOSE_TOO_MANY, "too many terminal streams");
      return;
    }
    const stream = new HerdrStream(ws, ws.data.paneId, ws.data.hint);
    ws.data.stream = stream;
    void stream.start();
  },
  message(ws: ServerWebSocket<HerdrStreamSocketData>, msg: string | Buffer): void {
    ws.data.stream?.onMessage(msg);
  },
  drain(ws: ServerWebSocket<HerdrStreamSocketData>): void {
    ws.data.stream?.onDrain();
  },
  close(ws: ServerWebSocket<HerdrStreamSocketData>): void {
    ws.data.stream?.dispose("client closed");
  },
};
