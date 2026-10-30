// ui-guard-allow-file(hex): terminal theme
"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { cn, toast } from "@/components/ui";
import { copyText } from "@/lib/clipboard";
import { HerdrStreamClient, type HerdrStreamStatus } from "@/lib/herdr-stream-client";
import { PASTE_LIMIT_BYTES, SCROLL_MAX, type HerdrStreamServerMessage } from "@/lib/herdr-stream-protocol";
import {
  applyModifiers,
  autoFontSize,
  clampFont,
  hasModifiers,
  isSingleKey,
  namedKeyFor,
  swipeLines,
  type StickyModifiers,
} from "@/lib/herdr-term-keys";
import { HERDR_XTERM_FONT, HERDR_XTERM_THEME } from "./HerdrXterm";

// herdr 窗格的实时终端（/herdr-stream WebSocket，见 lib/herdr-stream.ts）。
//
// 和轮询版 HerdrXterm 的根本区别：
//   · 不再每 3 秒 reset()+整屏重写（闪、滚动位置丢）——服务端推 full 帧一次、之后只推差分；
//   · 能直接打字：onData 原样发给服务端（方向键由服务端交给 herdr 按窗格模式编码）；
//   · xterm 的网格 = 真实窗格的网格（observe 是裁剪不是重排），靠字号适配 / 平移去塞进屏幕；
//   · scrollback 为 0：帧是按绝对坐标改写单元格，本地滚动缓冲没有意义；看历史走 pane.scroll。

const FONT_KEY = "trellis-herdr-term-font";
const LINE_HEIGHT = 1.1;

export type HerdrLiveTerminalHandle = {
  /** 键栏按键：原始字节（会套上粘滞修饰键）。 */
  sendBytes(data: string): void;
  /** herdr 具名键（shift+enter 等）。 */
  sendKey(name: string): void;
  focus(): void;
  /** 当前网格（复制屏幕时决定读多少行）。 */
  grid(): { cols: number; rows: number };
  /** 实际在用的字号（自动适配算出来的那个）。 */
  appliedFontSize(): number;
  reconnect(): void;
};

export type HerdrLiveTerminalProps = {
  paneId: string;
  /** 外部只读（herdr 协议不匹配等）。服务端也会在 ready 里报只读，两者取或。 */
  readOnly: boolean;
  onStatus: (status: HerdrStreamStatus, detail?: string) => void;
  /** 粘滞修饰键：软键盘输入也要吃到（键栏和终端共享同一份）。 */
  modifiers: StickyModifiers;
  onModifiersConsumed: () => void;
  /** 选择文本模式：盖一层可原生选中的纯文本（手机上 xterm 自己的选区不好用）。 */
  selectMode: boolean;
  /** null = 自动适配；数字 = 用户手动字号（双指缩放 / A± 按钮）。 */
  fontSize: number | null;
  onFontSizeChange: (size: number | null) => void;
  /** 挂载 / 卸载时交出（或收回）操作句柄。故意不叫 ref：父组件把它从 hook 结果里取出来传，
   *  叫 ref 会让 React 编译器把整个 hook 结果都当成 ref、禁止 render 期间读。 */
  onHandle?: (handle: HerdrLiveTerminalHandle | null) => void;
};

export function readStoredFontSize(): number | null {
  try {
    const v = Number(localStorage.getItem(FONT_KEY));
    return Number.isFinite(v) && v > 0 ? clampFont(v) : null;
  } catch {
    return null;
  }
}

export function storeFontSize(size: number | null): void {
  try {
    if (size === null) localStorage.removeItem(FONT_KEY);
    else localStorage.setItem(FONT_KEY, String(size));
  } catch {
    /* 隐私模式：不持久化而已 */
  }
}

/** 用 canvas 量等宽字体的 cell。和 xterm DOM 渲染器的取整方式近似，最后再按实际 DOM 校正一次。 */
function makeMeasure(): (fontSize: number) => { width: number; height: number } | null {
  const ctx = document.createElement("canvas").getContext("2d");
  const cache = new Map<number, { width: number; height: number }>();
  return (fs) => {
    const hit = cache.get(fs);
    if (hit) return hit;
    if (!ctx) return null;
    ctx.font = `${fs}px ${HERDR_XTERM_FONT}`;
    const m = ctx.measureText("W");
    const h = (m.fontBoundingBoxAscent ?? fs * 0.8) + (m.fontBoundingBoxDescent ?? fs * 0.25);
    const cell = { width: m.width, height: Math.ceil(h * LINE_HEIGHT) };
    cache.set(fs, cell);
    return cell;
  };
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function HerdrLiveTerminal({
  paneId,
  readOnly,
  onStatus,
  modifiers,
  onModifiersConsumed,
  selectMode,
  fontSize,
  onFontSizeChange,
  onHandle,
}: HerdrLiveTerminalProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const clientRef = useRef<HerdrStreamClient | null>(null);
  const gridRef = useRef({ cols: 80, rows: 24 });
  const [grid, setGrid] = useState({ cols: 80, rows: 24 });
  const [serverReadOnly, setServerReadOnly] = useState(false);
  const [status, setStatus] = useState<{ s: HerdrStreamStatus; detail?: string }>({ s: "connecting" });
  const [appliedFont, setAppliedFont] = useState(12);
  const [tier, setTier] = useState<"complete" | "width" | "pan">("complete");
  const [selectText, setSelectText] = useState("");
  const [generation, setGeneration] = useState(0);
  // pane.scroll 的累计偏移（行，离底部）。打字 / 点一下回到 0。
  const scrollRef = useRef({ offset: 0, max: SCROLL_MAX });
  const scrollSendRef = useRef<number | null>(null);

  // 回调与易变属性走 ref：xterm 和 WS 只建一次，不因为父组件重渲染而重连。
  // 在 layout effect 里同步（render 期间不许写 ref），且排在下面 refit 的 layout effect 之前。
  const live = useRef({ readOnly, onStatus, modifiers, onModifiersConsumed, onFontSizeChange, fontSize });
  useLayoutEffect(() => {
    live.current = { readOnly: readOnly || serverReadOnly, onStatus, modifiers, onModifiersConsumed, onFontSizeChange, fontSize };
  });

  const send = useCallback((msg: Parameters<HerdrStreamClient["send"]>[0]) => clientRef.current?.send(msg) ?? false, []);

  const setScroll = useCallback(
    (offset: number) => {
      const next = Math.max(0, Math.min(scrollRef.current.max, Math.round(offset)));
      if (next === scrollRef.current.offset) return;
      scrollRef.current.offset = next;
      // 一帧内的多次滚动只发最后一次。
      if (scrollSendRef.current !== null) return;
      scrollSendRef.current = requestAnimationFrame(() => {
        scrollSendRef.current = null;
        send({ t: "scroll", offset: scrollRef.current.offset });
      });
    },
    [send],
  );

  const sendInput = useCallback(
    (data: string) => {
      if (live.current.readOnly || !data) return;
      // 往历史里翻着时打字：先回到底部，和本地终端一样。
      if (scrollRef.current.offset > 0) {
        scrollRef.current.offset = 0;
        send({ t: "scroll", offset: 0 });
      }
      const mods = live.current.modifiers;
      if (hasModifiers(mods) && isSingleKey(data)) {
        live.current.onModifiersConsumed();
        const named = namedKeyFor(data, mods);
        if (named) {
          send({ t: "key", key: named });
          return;
        }
        data = applyModifiers(data, mods);
      }
      if (!send({ t: "input", data })) toast.error("终端未连接，这次输入没发出去");
    },
    [send],
  );

  const sendKey = useCallback(
    (name: string) => {
      if (live.current.readOnly) return;
      if (!send({ t: "key", key: name })) toast.error("终端未连接，这次按键没发出去");
    },
    [send],
  );

  const sendPaste = useCallback(
    (text: string) => {
      if (live.current.readOnly || !text) return;
      // 超限整条拒绝而不是截断：截断的半截命令被回车提交，后果和粘错一样。
      if (utf8Length(text) > PASTE_LIMIT_BYTES) {
        toast.error("粘贴内容超过 256 KiB，没有发送", { description: "大段文本请分几次粘贴，或用下方输入框。" });
        return;
      }
      if (scrollRef.current.offset > 0) {
        scrollRef.current.offset = 0;
        send({ t: "scroll", offset: 0 });
      }
      if (!send({ t: "paste", data: text })) toast.error("终端未连接，粘贴没发出去");
    },
    [send],
  );

  // ── 字号适配 ───────────────────────────────────────────────────────────
  const measureRef = useRef<ReturnType<typeof makeMeasure> | null>(null);
  // 每次 refit +1：下面 rAF 里的校正只认最新那次（网格中途变了，旧校正会把字号缩错）。
  const fitSeqRef = useRef(0);
  const refit = useCallback(() => {
    const term = termRef.current;
    const vp = viewportRef.current;
    if (!term || !vp) return;
    const seq = ++fitSeqRef.current;
    measureRef.current ??= makeMeasure();
    const box = { width: vp.clientWidth - 2, height: vp.clientHeight - 2 };
    let fs: number;
    let nextTier: "complete" | "width" | "pan";
    const manual = live.current.fontSize;
    if (manual !== null) {
      fs = manual;
      nextTier = "pan";
    } else {
      const auto = autoFontSize(box, gridRef.current, measureRef.current);
      fs = auto.fontSize;
      nextTier = auto.tier;
    }
    if (term.options.fontSize !== fs) term.options.fontSize = fs;
    setAppliedFont(fs);
    setTier(nextTier);
    // canvas 量出来的和 xterm 实际排出来的可能差零点几像素：自动模式下实际溢出就缩一档。
    if (manual === null && nextTier === "complete") {
      requestAnimationFrame(() => {
        if (seq !== fitSeqRef.current) return;
        const screen = hostRef.current?.querySelector(".xterm-screen") as HTMLElement | null;
        if (!screen || !termRef.current) return;
        const r = screen.getBoundingClientRect();
        const over = Math.max(r.width / Math.max(1, box.width), r.height / Math.max(1, box.height));
        if (over > 1.001) {
          const smaller = clampFont(Math.floor((fs / over) * 4) / 4);
          if (smaller < fs) {
            termRef.current.options.fontSize = smaller;
            setAppliedFont(smaller);
          }
        }
      });
    }
  }, []);

  useLayoutEffect(() => {
    refit();
  }, [fontSize, refit]);

  // ── xterm + WS 生命周期（每个窗格 / 每次手动重连建一次）────────────────
  useEffect(() => {
    let disposed = false;
    let term: Terminal | null = null;
    let client: HerdrStreamClient | null = null;
    const ro = new ResizeObserver(() => refit());

    void (async () => {
      const { Terminal } = await import("@xterm/xterm");
      if (disposed || !hostRef.current) return;
      term = new Terminal({
        cols: gridRef.current.cols,
        rows: gridRef.current.rows,
        scrollback: 0,
        cursorBlink: false,
        cursorStyle: "block",
        fontSize: 12,
        fontFamily: HERDR_XTERM_FONT,
        lineHeight: LINE_HEIGHT,
        theme: HERDR_XTERM_THEME,
        // 帧里全是绝对定位（CUP），不需要也不能让 xterm 自己把 \n 换成 \r\n。
        convertEol: false,
        allowTransparency: false,
        // 只读时 xterm 也别吐 onData（服务端同样会拒）。
        disableStdin: live.current.readOnly,
      });
      term.open(hostRef.current);
      termRef.current = term;

      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        // Shift+Enter：传统字节里没有，交给 herdr 按窗格的键盘协议编码（agent 里是换行）。
        if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          sendKey("shift+enter");
          return false;
        }
        const sel = term?.hasSelection() ? term.getSelection() : "";
        // 有选区时 Cmd/Ctrl+C 是复制；没选区的 Ctrl+C 照常发 ^C。
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "c" && sel) {
          e.preventDefault();
          void copyText(sel).then(() => term?.clearSelection());
          return false;
        }
        // Cmd 组合（⌘V 粘贴、⌘+/− 缩放、⌘R、⌘W…）一律还给浏览器。⌘C 没选区时也不发
        // ^C：习惯性按一下复制就把 agent 这一轮打断，代价太大。
        if (e.metaKey) return false;
        // Ctrl +/−/0 是浏览器缩放；Ctrl+Shift+C/V 是 Linux 浏览器的复制粘贴。
        if (e.ctrlKey && ["=", "+", "-", "0"].includes(e.key)) return false;
        if (e.ctrlKey && e.shiftKey && ["c", "v"].includes(e.key.toLowerCase())) return false;
        return true;
      });
      term.onData((data) => sendInput(data));

      client = new HerdrStreamClient(
        paneId,
        () => {
          // 兜底尺寸：服务端查不到真实窗格尺寸时才用。按当前视口和 12px 估一个。
          const vp = viewportRef.current;
          if (!vp) return null;
          measureRef.current ??= makeMeasure();
          const cell = measureRef.current(12);
          if (!cell) return null;
          return {
            cols: Math.max(20, Math.min(400, Math.floor(vp.clientWidth / cell.width))),
            rows: Math.max(5, Math.min(200, Math.floor(vp.clientHeight / cell.height))),
          };
        },
        {
          onStatus: (s, detail) => {
            setStatus({ s, detail });
            live.current.onStatus(s, detail);
          },
          onBytes: (bytes) => term?.write(bytes),
          onMessage: (msg: HerdrStreamServerMessage) => {
            switch (msg.t) {
              case "ready":
                setServerReadOnly(msg.readOnly);
                if (term) term.options.disableStdin = msg.readOnly || live.current.readOnly;
                scrollRef.current = { offset: 0, max: SCROLL_MAX };
                break;
              case "size":
                // 紧跟着的就是这个尺寸下的 full 帧：先 resize，再让它写。
                gridRef.current = { cols: msg.cols, rows: msg.rows };
                setGrid(gridRef.current);
                term?.resize(msg.cols, msg.rows);
                refit();
                break;
              case "scrolled":
                scrollRef.current.max = msg.max;
                // 用户已经接着划了就别拿旧回报覆盖。
                if (scrollSendRef.current === null) scrollRef.current.offset = msg.offset;
                break;
              case "error":
                if (msg.code === "input_failed" || msg.code === "read_only" || msg.code === "bad_request") {
                  toast.error(msg.message);
                }
                break;
              default:
                break;
            }
          },
        },
      );
      clientRef.current = client;
      client.start();
      if (viewportRef.current) ro.observe(viewportRef.current);
      refit();
    })();


    return () => {
      disposed = true;
      ro.disconnect();
      client?.stop();
      clientRef.current = null;
      if (scrollSendRef.current !== null) cancelAnimationFrame(scrollSendRef.current);
      scrollSendRef.current = null;
      try {
        term?.dispose();
      } catch {
        /* 销毁安全 */
      }
      termRef.current = null;
    };
  }, [paneId, generation, refit, sendInput, sendKey]);

  // 只读状态变化时同步给 xterm（不重建）。
  useEffect(() => {
    if (termRef.current) termRef.current.options.disableStdin = readOnly || serverReadOnly;
  }, [readOnly, serverReadOnly]);

  // ── 粘贴 / 滚轮 / 触摸 ────────────────────────────────────────────────
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;

    // 捕获阶段截住，xterm 自己的 paste 处理就不会再发一遍（它不知道限额和 ␛ 替换）。
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain") ?? "";
      e.preventDefault();
      e.stopPropagation();
      sendPaste(text);
    };

    const cellHeight = () => {
      const screen = hostRef.current?.querySelector(".xterm-screen") as HTMLElement | null;
      const h = screen ? screen.getBoundingClientRect().height / gridRef.current.rows : 0;
      return h > 0 ? h : 14;
    };
    const canScrollY = () => vp.scrollHeight > vp.clientHeight + 1;

    // 滚轮：视口自己能竖向滚（手动大字号溢出）就交给原生滚动；否则翻 herdr 的历史。
    // 同样在捕获阶段截住，免得 xterm 在某些缓冲模式下把滚轮翻译成方向键发出去。
    let wheelRemainder = 0;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // 触控板捏合缩放 = 浏览器 ctrl+wheel，别拦
      if (canScrollY()) {
        const atTop = vp.scrollTop <= 0;
        const atBottom = vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 1;
        if (!(e.deltaY < 0 && atTop) && !(e.deltaY > 0 && atBottom)) return;
      }
      e.preventDefault();
      e.stopPropagation();
      const px = e.deltaMode === 1 ? e.deltaY * cellHeight() : e.deltaMode === 2 ? e.deltaY * vp.clientHeight : e.deltaY;
      wheelRemainder += px;
      const lines = swipeLines(wheelRemainder, cellHeight());
      if (lines === 0) return;
      wheelRemainder -= lines * cellHeight();
      // 向下滚 = 往新内容走 = 离底部更近。
      setScroll(scrollRef.current.offset - lines);
    };

    // 触摸：单指竖滑翻历史（视口自己能竖向滚时让原生滚）；轻点聚焦并回到底部；双指捏合改字号。
    let touch:
      | { mode: "pending" | "scroll" | "native"; x: number; y: number; lastY: number; t: number; remainder: number }
      | { mode: "pinch"; dist: number; base: number }
      | null = null;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        touch = { mode: "pinch", dist: dist(e.touches), base: termRef.current?.options.fontSize ?? 12 };
        return;
      }
      if (e.touches.length !== 1) return;
      const p = e.touches[0];
      touch = { mode: "pending", x: p.clientX, y: p.clientY, lastY: p.clientY, t: Date.now(), remainder: 0 };
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!touch) return;
      if (touch.mode === "pinch") {
        if (e.touches.length !== 2) return;
        e.preventDefault(); // 页面缩放让给终端字号
        const next = clampFont((touch.base * dist(e.touches)) / Math.max(1, touch.dist));
        if (termRef.current && termRef.current.options.fontSize !== next) {
          live.current.onFontSizeChange(next);
        }
        return;
      }
      if (selectMode || e.touches.length !== 1) return;
      const p = e.touches[0];
      if (touch.mode === "pending") {
        const dx = p.clientX - touch.x;
        const dy = p.clientY - touch.y;
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        touch.mode = Math.abs(dy) > Math.abs(dx) && !canScrollY() ? "scroll" : "native";
      }
      if (touch.mode !== "scroll") return;
      e.preventDefault();
      touch.remainder += p.clientY - touch.lastY;
      touch.lastY = p.clientY;
      const lines = swipeLines(touch.remainder, cellHeight());
      if (lines === 0) return;
      touch.remainder -= lines * cellHeight();
      // 手指往下拖 = 看更早的内容 = 离底部更远。
      setScroll(scrollRef.current.offset + lines);
    };
    const onTouchEnd = (e: TouchEvent) => {
      const t = touch;
      if (e.touches.length > 0) return;
      touch = null;
      if (!t || t.mode !== "pending" || selectMode) return;
      // 轻点：聚焦（手机上弹出软键盘），在历史里就回到底部。
      if (Date.now() - t.t < 400) {
        termRef.current?.focus();
        if (scrollRef.current.offset > 0) setScroll(0);
      }
    };

    vp.addEventListener("paste", onPaste, true);
    vp.addEventListener("wheel", onWheel, { capture: true, passive: false });
    vp.addEventListener("touchstart", onTouchStart, { passive: true });
    vp.addEventListener("touchmove", onTouchMove, { passive: false });
    vp.addEventListener("touchend", onTouchEnd);
    vp.addEventListener("touchcancel", onTouchEnd);
    return () => {
      vp.removeEventListener("paste", onPaste, true);
      vp.removeEventListener("wheel", onWheel, true);
      vp.removeEventListener("touchstart", onTouchStart);
      vp.removeEventListener("touchmove", onTouchMove);
      vp.removeEventListener("touchend", onTouchEnd);
      vp.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [selectMode, sendPaste, setScroll]);

  // 双指缩放结束后才持久化（缩放过程中每一帧都写 localStorage 没必要）。
  useEffect(() => {
    const t = setTimeout(() => storeFontSize(fontSize), 400);
    return () => clearTimeout(t);
  }, [fontSize]);

  // 网格比视口大时，新帧到来默认贴底（提示符在最下面）。
  useEffect(() => {
    const vp = viewportRef.current;
    if (vp && tier !== "complete") vp.scrollTop = vp.scrollHeight;
  }, [grid, tier, appliedFont]);

  // 选择文本模式：把当前屏幕抄成纯文本盖在上面，用系统原生的选区（长按 / 拖选）。
  useEffect(() => {
    if (!selectMode) return;
    const term = termRef.current;
    if (!term) return;
    const buf = term.buffer.active;
    const lines: string[] = [];
    // herdr 帧里的空白是显式写进去的空格（带底色），translateToString 的 trimRight 去不掉，自己去。
    for (let y = 0; y < term.rows; y++) {
      lines.push((buf.getLine(y)?.translateToString(true) ?? "").replace(/\s+$/, ""));
    }
    // 首帧 effect 内同步一次快照即可：选择期间屏幕继续变化会把用户的选区冲掉。
    setSelectText(lines.join("\n").replace(/\n+$/, ""));
  }, [selectMode]);

  useEffect(() => {
    if (!onHandle) return;
    onHandle({
      sendBytes: (data) => sendInput(data),
      sendKey,
      focus: () => termRef.current?.focus(),
      grid: () => gridRef.current,
      appliedFontSize: () => termRef.current?.options.fontSize ?? 12,
      reconnect: () => setGeneration((g) => g + 1),
    });
    return () => onHandle(null);
  }, [onHandle, sendInput, sendKey]);

  const overlay =
    status.s === "connecting"
      ? "正在连接实时终端…"
      : status.s === "offline"
        ? status.detail ?? "终端已离线"
        : status.s === "reconnecting"
          ? status.detail ?? "连接断开，正在重连…"
          : null;

  return (
    <div
      ref={viewportRef}
      data-herdr-live-terminal={paneId}
      data-tier={tier}
      className={cn(
        "relative min-h-0 w-full flex-1 overflow-auto overscroll-contain bg-[#0a0b10]",
        // 禁掉页面级双指缩放（交给终端字号），保留平移。
        "touch-pan-x touch-pan-y",
      )}
    >
      <div ref={hostRef} className="inline-block align-top" style={{ lineHeight: "normal" }} />
      {selectMode && (
        <pre
          aria-label="终端屏幕文本（可选中复制）"
          className="absolute inset-0 m-0 overflow-auto whitespace-pre bg-[#0a0b10]/95 p-1 font-mono text-[#e4e6ee] select-text"
          style={{ fontSize: appliedFont, lineHeight: LINE_HEIGHT, WebkitUserSelect: "text", userSelect: "text" }}
        >
          {selectText}
        </pre>
      )}
      {overlay && (
        <div
          role="status"
          className={cn(
            "pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-line-strong bg-surface-raised/95 px-3 py-1 text-label text-ink shadow-lg",
            status.s === "offline" && "border-danger/60 text-danger",
          )}
        >
          {overlay}
        </div>
      )}
    </div>
  );
}
