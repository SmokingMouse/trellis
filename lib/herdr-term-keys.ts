// 实时终端的辅助键栏与粘滞修饰键（纯逻辑，浏览器用；单测见 herdr-term-keys.test.ts）。
//
// 键栏上的键产出的是「原始字节」，和软键盘 / 硬件键盘走同一条 onData 通道发出去，
// 方向键的 DECCKM 编码由服务端 splitInput 交给 herdr 处理（见 herdr-stream-protocol）。
// 只有传统字节里表达不了的组合（Shift+Enter）才走具名键。

export type AuxKey = {
  id: string;
  label: string;
  /** 直接送进终端的字节。 */
  bytes: string;
  /** 读屏用的中文名：按钮文字多是符号。 */
  aria: string;
  /** 长按连发（方向键、退格）。 */
  repeat?: boolean;
  /** 桌面紧凑键栏也显示。 */
  compact?: boolean;
  /** 实时流不可用、回退轮询时走 /command 路由用的 herdr 键名。 */
  herdrKey: string;
};

export const AUX_KEYS: AuxKey[] = [
  { id: "esc", label: "Esc", bytes: "\x1b", aria: "Esc 键", compact: true, herdrKey: "Escape" },
  { id: "tab", label: "Tab", bytes: "\t", aria: "Tab 键", compact: true, herdrKey: "Tab" },
  { id: "left", label: "←", bytes: "\x1b[D", aria: "方向键左", repeat: true, herdrKey: "left" },
  { id: "up", label: "↑", bytes: "\x1b[A", aria: "方向键上", repeat: true, compact: true, herdrKey: "up" },
  { id: "down", label: "↓", bytes: "\x1b[B", aria: "方向键下", repeat: true, compact: true, herdrKey: "down" },
  { id: "right", label: "→", bytes: "\x1b[C", aria: "方向键右", repeat: true, herdrKey: "right" },
  { id: "bs", label: "⌫", bytes: "\x7f", aria: "退格键", repeat: true, herdrKey: "Backspace" },
  { id: "ctrlc", label: "^C", bytes: "\x03", aria: "中断 Ctrl+C", compact: true, herdrKey: "ctrl+c" },
  { id: "enter", label: "⏎", bytes: "\r", aria: "回车键", compact: true, herdrKey: "Enter" },
  // agent 选项对话框最常用的两个快捷答复。
  { id: "one", label: "1", bytes: "1", aria: "按键 1", compact: true, herdrKey: "1" },
  { id: "two", label: "2", bytes: "2", aria: "按键 2", compact: true, herdrKey: "2" },
];

/** 长按连发：先等一会儿再连续发，避免误触连发。 */
export const KEY_REPEAT_DELAY_MS = 450;
export const KEY_REPEAT_INTERVAL_MS = 60;

export type StickyModifiers = { ctrl: boolean; alt: boolean; shift: boolean };
export const NO_MODIFIERS: StickyModifiers = { ctrl: false, alt: false, shift: false };

export const MODIFIER_KEYS: { id: keyof StickyModifiers; label: string; aria: string }[] = [
  { id: "ctrl", label: "Ctrl", aria: "Ctrl 修饰键，作用于下一个键" },
  { id: "alt", label: "Alt", aria: "Alt 修饰键，作用于下一个键" },
  { id: "shift", label: "⇧", aria: "Shift 修饰键，作用于下一个键" },
];

export function hasModifiers(m: StickyModifiers): boolean {
  return m.ctrl || m.alt || m.shift;
}

/** xterm 的修饰参数：1 + Shift(1) + Alt(2) + Ctrl(4)。 */
function modifierParam(m: StickyModifiers): number {
  return 1 + (m.shift ? 1 : 0) + (m.alt ? 2 : 0) + (m.ctrl ? 4 : 0);
}

/** 方向键（普通或应用光标模式）的结尾字母。 */
function arrowFinal(data: string): string {
  return data.length === 3 && data[0] === "\x1b" && (data[1] === "[" || data[1] === "O") && "ABCD".includes(data[2])
    ? data[2]
    : "";
}

/** 单个字符加 Ctrl：字母与 @[\]^_ 映射到 C0，空格 → NUL，? → DEL；其余原样。 */
function controlChar(ch: string): string {
  if (ch === " ") return "\x00";
  if (ch === "?") return "\x7f";
  const code = ch.toUpperCase().charCodeAt(0);
  return code >= 0x40 && code <= 0x5f ? String.fromCharCode(code & 0x1f) : ch;
}

/**
 * 是不是「一个键」。修饰键只被这样的输入消耗：输入法一次上屏的一串字、粘贴、
 * xterm 自己回报的焦点 / 设备属性序列都不该把按下的 Ctrl 用掉。
 */
export function isSingleKey(data: string): boolean {
  return Boolean(arrowFinal(data)) || data === "\x1b[Z" || [...data].length === 1;
}

/**
 * 需要走 herdr 具名键的组合：粘滞 ⇧ + 回车 = shift+enter（多数 agent 当换行）。
 * 传统字节里没有它，直发 \r 会直接提交。
 */
export function namedKeyFor(data: string, m: StickyModifiers): string | null {
  return data === "\r" && m.shift && !m.ctrl && !m.alt ? "shift+enter" : null;
}

/**
 * 把一个键的字节换成带修饰的字节（先用 namedKeyFor 处理具名组合）。方向键走
 * CSI 1;m X；Tab / 退格 / 单字符按传统终端规则；Alt 一律是前缀 ESC。不是「一个键」
 * 的输入原样返回。
 */
export function applyModifiers(data: string, m: StickyModifiers): string {
  if (!hasModifiers(m) || !isSingleKey(data)) return data;
  const meta = m.alt ? "\x1b" : "";
  const arrow = arrowFinal(data);
  if (arrow) return `\x1b[1;${modifierParam(m)}${arrow}`;
  if (data === "\t") return meta + (m.shift ? "\x1b[Z" : "\t");
  if (data === "\x7f") return meta + (m.ctrl ? "\x08" : "\x7f");
  let ch = data;
  if (ch.length > 1 || ch.charCodeAt(0) < 0x20) return meta + ch;
  if (m.shift) ch = ch.toUpperCase();
  if (m.ctrl) ch = controlChar(ch);
  return meta + ch;
}

// ── 字号 ──────────────────────────────────────────────────────────────────

export const FONT_MIN = 6;
export const FONT_MAX = 24;
/** 自动适配时低于这个字号就不再硬塞，改成横向平移（看不清比要平移更糟）。 */
export const AUTO_FONT_FLOOR = 7;
export const AUTO_FONT_CEIL = 14;

export type CellMetrics = (fontSize: number) => { width: number; height: number } | null;

/**
 * 找能把 cols×rows 网格塞进 width×height 的最大字号（0.25px 步进的二分）。
 * fitHeight=false 只按宽度适配（窗格比屏幕高很多时，竖向平移读起来像翻页）。
 */
export function fitFontSize(
  box: { width: number; height: number },
  grid: { cols: number; rows: number },
  measure: CellMetrics,
  opts: { min?: number; max?: number; fitHeight?: boolean } = {},
): number | null {
  const min = opts.min ?? FONT_MIN;
  const max = opts.max ?? AUTO_FONT_CEIL;
  if (box.width <= 0 || box.height <= 0 || grid.cols <= 0 || grid.rows <= 0) return null;
  let lo = Math.round(min * 4);
  let hi = Math.round(max * 4);
  let best: number | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const cell = measure(mid / 4);
    if (!cell || cell.width <= 0 || cell.height <= 0) return null;
    const fitsW = cell.width * grid.cols <= box.width;
    const fitsH = opts.fitHeight === false || cell.height * grid.rows <= box.height;
    if (fitsW && fitsH) {
      best = mid / 4;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * 自动字号：整屏塞得下且不小于下限就整屏；否则只按宽度；还不行就用下限字号、
 * 两个方向都平移。tier 供界面决定要不要贴底滚动。
 */
export function autoFontSize(
  box: { width: number; height: number },
  grid: { cols: number; rows: number },
  measure: CellMetrics,
): { fontSize: number; tier: "complete" | "width" | "pan" } {
  const complete = fitFontSize(box, grid, measure, { min: AUTO_FONT_FLOOR });
  if (complete !== null) return { fontSize: complete, tier: "complete" };
  const width = fitFontSize(box, grid, measure, { min: AUTO_FONT_FLOOR, fitHeight: false });
  if (width !== null) return { fontSize: width, tier: "width" };
  return { fontSize: AUTO_FONT_FLOOR, tier: "pan" };
}

export function clampFont(size: number): number {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(size * 4) / 4));
}

// ── 重连 ──────────────────────────────────────────────────────────────────

export const RECONNECT_DELAYS_S = [1, 2, 5, 5, 10, 30];
/** 连续失败这么多次（一次都没 ready 过）就判定实时流不可用，回退轮询。 */
export const FALLBACK_AFTER_FAILURES = 4;

/** 第 attempt 次重连（0 起）的等待毫秒数，带 ±20% 抖动，避免一群标签页同一刻扑上来。 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = RECONNECT_DELAYS_S[Math.min(attempt, RECONNECT_DELAYS_S.length - 1)] * 1000;
  return Math.round(base * (0.8 + random() * 0.4));
}

/** 竖向滑动的像素换算成行数（每行一个 cell 高）；正值 = 往历史方向。 */
export function swipeLines(dyPx: number, cellHeight: number): number {
  if (cellHeight <= 0) return 0;
  return Math.trunc(dyPx / cellHeight);
}
