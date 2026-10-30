// herdr 实时终端流（/herdr-stream）的协议与纯逻辑。浏览器和大门（server.ts）共用，
// 所以这里不能 import 任何 server-only / DOM 专属的东西。
//
// 为什么是「观察 + 按源尺寸渲染」而不是「按浏览器尺寸渲染」：实测 herdr 0.9.3 的
// `terminal session observe --cols C --rows R` **不会重排**，它只是把真实窗格的屏幕
// 从左上角裁出 C×R 一块（窗格 104×53、观察 40×8 时只看得到前 8 行的前 40 列——提示符
// 在最底下，直接看不见）。而用户拍板「只观察、永远不改真实窗格尺寸」，所以唯一正确的
// 做法是：服务端查出真实窗格的 cols×rows，按这个尺寸观察；浏览器的 xterm 也用同一个
// 网格，靠缩放字号 / 平移去适配屏幕。

/** 浏览器 → 大门的 JSON 文本消息。 */
export type HerdrStreamClientMessage =
  | { t: "input"; data: string }
  | { t: "paste"; data: string }
  | { t: "key"; key: string }
  | { t: "scroll"; offset: number }
  | { t: "resize"; cols: number; rows: number }
  | { t: "ping" };

/** 大门 → 浏览器的 JSON 文本消息（终端字节走二进制帧，不走这里）。 */
export type HerdrStreamServerMessage =
  | { t: "ready"; readOnly: boolean }
  // 网格尺寸：紧跟着的二进制帧就是这个尺寸下的整屏，浏览器必须先 resize 再写。
  | { t: "size"; cols: number; rows: number; source: "pane" | "client" }
  | { t: "scrolled"; offset: number; max: number }
  | { t: "error"; message: string; code?: HerdrStreamErrorCode }
  | { t: "exit"; reason: string }
  | { t: "pong" };

export type HerdrStreamErrorCode =
  | "bad_request"
  | "read_only"
  | "input_failed"
  | "unsupported"
  | "pane_not_found"
  | "unavailable";

// WS 关闭码（4000–4999 是应用自定义段）。浏览器靠它区分「该重连」和「别再连了」。
export const CLOSE_PANE_GONE = 4404;
/** herdr 太旧（没有 terminal session observe）或 herdr 被关：回退轮询，别重连。 */
export const CLOSE_UNSUPPORTED = 4501;
export const CLOSE_TOO_MANY = 4429;

export const HERDR_STREAM_PATH = "/herdr-stream";

export const COLS_MIN = 20;
export const COLS_MAX = 400;
export const ROWS_MIN = 5;
export const ROWS_MAX = 200;
/** 一条输入 / 粘贴的上限（UTF-8 字节）。超过就整条拒绝——截断的半截命令被回车提交，后果和粘错一样。 */
export const PASTE_LIMIT_BYTES = 256 * 1024;
/** 客户端消息体积上限：粘贴上限 + JSON 转义余量。 */
export const CLIENT_MESSAGE_MAX_BYTES = PASTE_LIMIT_BYTES * 2 + 1024;
export const SCROLL_MAX = 100_000;
export const MAX_STREAMS = 32;

// 窗格 id 形如 w4:p2K。它会作为 argv 元素传给 herdr CLI（不过 shell），但仍然
// 不许以 "-" 开头，免得被当成选项。
const PANE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export function isValidPaneId(id: unknown): id is string {
  return typeof id === "string" && PANE_ID_RE.test(id);
}

function intInRange(raw: unknown, min: number, max: number): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export function clampGrid(cols: number, rows: number): { cols: number; rows: number } {
  return {
    cols: Math.min(COLS_MAX, Math.max(COLS_MIN, Math.round(cols))),
    rows: Math.min(ROWS_MAX, Math.max(ROWS_MIN, Math.round(rows))),
  };
}

/**
 * 解析 /herdr-stream 的查询串：pane 必填；cols/rows 是浏览器的「兜底尺寸」——只有服务端
 * 查不出真实窗格尺寸时才用它（见文件头）。给了就必须在范围内，给一半算错。
 */
export function parseStreamParams(
  search: URLSearchParams,
): { ok: true; paneId: string; hint: { cols: number; rows: number } | null } | { ok: false; error: string } {
  const paneId = search.get("pane");
  if (!isValidPaneId(paneId)) return { ok: false, error: "invalid pane id" };
  const rawCols = search.get("cols");
  const rawRows = search.get("rows");
  if (rawCols === null && rawRows === null) return { ok: true, paneId, hint: null };
  const cols = intInRange(rawCols, COLS_MIN, COLS_MAX);
  const rows = intInRange(rawRows, ROWS_MIN, ROWS_MAX);
  if (cols === null || rows === null) {
    return { ok: false, error: `cols/rows must be ${COLS_MIN}-${COLS_MAX} / ${ROWS_MIN}-${ROWS_MAX}` };
  }
  return { ok: true, paneId, hint: { cols, rows } };
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** 校验一条浏览器消息。返回 { error } = 不认识或越界，调用方回 bad_request。 */
export function parseClientMessage(raw: string): HerdrStreamClientMessage | { error: string } {
  if (raw.length > CLIENT_MESSAGE_MAX_BYTES) return { error: "message too large" };
  let msg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { error: "expected object" };
    msg = parsed as Record<string, unknown>;
  } catch {
    return { error: "invalid JSON" };
  }
  switch (msg.t) {
    case "input":
    case "paste": {
      if (typeof msg.data !== "string" || msg.data.length === 0) return { error: "empty data" };
      if (utf8Length(msg.data) > PASTE_LIMIT_BYTES) return { error: "粘贴内容超过 256 KiB" };
      return { t: msg.t, data: msg.data };
    }
    case "key":
      return typeof msg.key === "string" && HERDR_KEY_NAMES.has(msg.key)
        ? { t: "key", key: msg.key }
        : { error: "unsupported key" };
    case "scroll": {
      const offset = intInRange(msg.offset, 0, SCROLL_MAX);
      return offset === null ? { error: "invalid scroll offset" } : { t: "scroll", offset };
    }
    case "resize": {
      const cols = intInRange(msg.cols, COLS_MIN, COLS_MAX);
      const rows = intInRange(msg.rows, ROWS_MIN, ROWS_MAX);
      return cols === null || rows === null ? { error: "invalid size" } : { t: "resize", cols, rows };
    }
    case "ping":
      return { t: "ping" };
    default:
      return { error: "unknown message type" };
  }
}

// ── observe 的 NDJSON ──────────────────────────────────────────────────────

export type ObserveFrame = {
  kind: "frame";
  seq: number;
  cols: number;
  rows: number;
  full: boolean;
  bytes: Uint8Array;
};
export type ObserveEvent = ObserveFrame | { kind: "closed"; reason: string };

/** 单帧上限：200×400 的整屏带满 SGR 也才几百 KB，8 MB 以上只可能是坏数据。 */
const FRAME_MAX_BASE64 = 11 << 20;

function decodeBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 解析 `herdr terminal session observe` 的一行输出。实测格式：
 *   {"type":"terminal.frame","encoding":"ansi","bytes":"<b64>","full":true,"seq":1,"width":80,"height":20}
 *   {"type":"terminal.closed","reason":"terminal attach ended: ..."}
 * full 帧以 ESC[2J 开头，可以直接写进 xterm；非 full 帧是按绝对坐标改写单元格的差分
 * （ESC[r;cH + 文本，外面包一层 ?2026 同步输出），前提是 xterm 的网格与 width×height 一致。
 * 不认识的行一律忽略（返回 null），别因为 herdr 多吐一种事件就把流掐了。
 */
export function parseObserveLine(line: string): ObserveEvent | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > FRAME_MAX_BASE64) return null;
  let d: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return null;
    d = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (d.type === "terminal.closed") {
    return { kind: "closed", reason: typeof d.reason === "string" ? d.reason : "closed" };
  }
  if (d.type !== "terminal.frame" || d.encoding !== "ansi" || typeof d.bytes !== "string") return null;
  const cols = Number(d.width);
  const rows = Number(d.height);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return null;
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(d.bytes);
  } catch {
    return null;
  }
  return { kind: "frame", seq: Number(d.seq) || 0, cols, rows, full: d.full === true, bytes };
}

/**
 * 把子进程 stdout 的字节块切成行。observe 一帧一行，但一个 read() 可能是半行或多行。
 * 用 TextDecoder 的 stream 模式：base64 本身是 ASCII，但 reason 里可能有中文。
 */
export class LineSplitter {
  private buf = "";
  private readonly decoder = new TextDecoder();
  constructor(private readonly maxLine = FRAME_MAX_BASE64 + 4096) {}

  push(chunk: Uint8Array): string[] {
    this.buf += this.decoder.decode(chunk, { stream: true });
    const lines: string[] = [];
    let nl = this.buf.indexOf("\n");
    while (nl >= 0) {
      lines.push(this.buf.slice(0, nl));
      this.buf = this.buf.slice(nl + 1);
      nl = this.buf.indexOf("\n");
    }
    // 没有换行却越攒越大 = 坏流；丢掉，别让一个坏子进程吃光内存。
    if (this.buf.length > this.maxLine) this.buf = "";
    return lines;
  }
}

/**
 * 输出合帧：忙碌的窗格一秒能吐几十帧，逐帧发会把手机打满。差分按顺序拼接即可；
 * 遇到 full 帧则它之前攒的全部作废（full 自带清屏）。尺寸跟最后一帧走。
 */
export class FrameCoalescer {
  private parts: Uint8Array[] = [];
  private size = 0;
  full = false;
  cols = 0;
  rows = 0;

  get empty(): boolean {
    return this.parts.length === 0;
  }

  get bytes(): number {
    return this.size;
  }

  push(frame: ObserveFrame): void {
    if (frame.full) {
      this.parts = [];
      this.size = 0;
      this.full = true;
    }
    this.parts.push(frame.bytes);
    this.size += frame.bytes.byteLength;
    this.cols = frame.cols;
    this.rows = frame.rows;
  }

  take(): { bytes: Uint8Array; full: boolean; cols: number; rows: number } | null {
    if (this.parts.length === 0) return null;
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    const result = { bytes: out, full: this.full, cols: this.cols, rows: this.rows };
    this.clear();
    return result;
  }

  clear(): void {
    this.parts = [];
    this.size = 0;
    this.full = false;
  }
}

// ── 背压 ──────────────────────────────────────────────────────────────────

export const BACKPRESSURE_HIGH = 2 * 1024 * 1024;
export const BACKPRESSURE_LOW = 256 * 1024;

/**
 * 浏览器读不动（手机切后台、弱网）时怎么办。不能无限缓冲——差分帧丢一帧屏幕就花了，
 * 攒着又会把大门内存吃光。所以：超过高水位就「停流」（杀掉 observe、丢弃待发），
 * 降到低水位以下再重开 observe——新子进程第一帧必是 full，屏幕自然恢复正确。
 */
export function backpressureAction(
  buffered: number,
  stalled: boolean,
): "send" | "stall" | "wait" | "resume" {
  if (stalled) return buffered <= BACKPRESSURE_LOW ? "resume" : "wait";
  return buffered > BACKPRESSURE_HIGH ? "stall" : "send";
}

// ── 输入 ──────────────────────────────────────────────────────────────────

/**
 * herdr pane.send_keys 认的键名（实测 0.9.3：up/left/F5/ctrl+left/alt+x/shift+tab/
 * shift+enter/Backspace/Tab/Space/Escape/Enter/ctrl+<字母> 可用；Home/End/PageUp/Delete
 * 不认）。浏览器只能发白名单里的。
 */
export const HERDR_KEY_NAMES = new Set([
  "Enter",
  "shift+enter",
  "Tab",
  "shift+tab",
  "Escape",
  "Backspace",
  "Space",
  "up",
  "down",
  "left",
  "right",
  ...Array.from({ length: 26 }, (_, i) => `ctrl+${String.fromCharCode(97 + i)}`),
]);

/** 发给 herdr 的一段输入：字面字节走 pane.send_text，具名键走 pane.send_keys。 */
export type HerdrInputSegment = { text: string } | { keys: string[] };

// 方向键要交给 herdr 编码，不能直发字节：observe 帧里**不带**输入模式（实测 full 帧里
// 没有 ?1h / ?2004h），浏览器侧的 xterm 永远以为自己在普通光标模式、发 ESC[A；而真实
// 窗格里的 TUI 可能开了应用光标模式（DECCKM）在等 ESC OA。herdr 的 send_keys("up")
// 按窗格当前模式编码（实测 ?1h 下发出 ^[OA），所以四个方向键由它来编。
const ARROW_KEYS: Record<string, string> = {
  "\x1b[A": "up",
  "\x1b[B": "down",
  "\x1b[C": "right",
  "\x1b[D": "left",
  "\x1bOA": "up",
  "\x1bOB": "down",
  "\x1bOC": "right",
  "\x1bOD": "left",
};
const ARROW_RE = /\x1b[[O][ABCD]/g;

/** 单段文本的上限：大粘贴切成多次 send_text，单个 JSON-RPC 请求别太大。 */
const TEXT_CHUNK = 64 * 1024;

function chunkText(text: string): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(text.length, at + TEXT_CHUNK);
    // 别把代理对（emoji、生僻字）劈成两半。
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end--;
    }
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}

/**
 * 把 xterm onData 的一段原始输入拆成 herdr 调用序列。实测 pane.send_text 对控制字节是
 * 透明的（\x03 中断、\x7f 退格、\t、\r、ESC 序列原样进 PTY），所以除方向键外全部字面发送。
 * 相邻的方向键合并成一次 send_keys，保持顺序。
 */
export function splitInput(data: string): HerdrInputSegment[] {
  const segs: HerdrInputSegment[] = [];
  const pushText = (text: string) => {
    for (const piece of chunkText(text)) segs.push({ text: piece });
  };
  let last = 0;
  for (const m of data.matchAll(ARROW_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) pushText(data.slice(last, idx));
    const key = ARROW_KEYS[m[0]];
    const prev = segs[segs.length - 1];
    if (prev && "keys" in prev && idx === last) prev.keys.push(key);
    else segs.push({ keys: [key] });
    last = idx + m[0].length;
  }
  if (last < data.length) pushText(data.slice(last));
  return segs;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * 粘贴：正文里的 ESC 一律换成可见的「␛」——正文里只要带着真的 ESC，就可能提前结束
 * 粘贴框（或干脆是一段恶意控制序列），后面的字节会被当成按键执行。换行统一成 \r
 * （终端里回车就是 \r，和 xterm 自己处理粘贴一致）。
 *
 * 多行才包 bracketed paste：herdr 不告诉我们窗格当前开没开 ?2004（读不到），而
 * claude / codex / zsh / bash 5.1+ 都默认开。不包的话多行粘贴进 shell 会逐行执行、
 * 粘进 agent 输入框会在第一个换行处直接提交——这比偶尔在不认粘贴框的程序（cat、
 * 老 python REPL）里看到一串 ^[[200~ 危险得多。单行粘贴不包，避免这类误伤。
 */
export function preparePaste(text: string): string {
  const body = text.replaceAll("\x1b", "␛").replace(/\r\n?|\n/g, "\r");
  return body.includes("\r") ? `${PASTE_START}${body}${PASTE_END}` : body;
}
