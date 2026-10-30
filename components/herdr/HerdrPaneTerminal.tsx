// ui-guard-allow-file(hex): terminal high contrast theme
"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ClipboardCopy, TextSelect } from "lucide-react";
import { Button, Icon, Modal, cn, toast } from "@/components/ui";
import { copyText } from "@/lib/clipboard";
import { readHerdrPane, sendHerdrCommand } from "@/lib/herdr-actions";
import type { HerdrStreamStatus } from "@/lib/herdr-stream-client";
import { FONT_MAX, FONT_MIN, NO_MODIFIERS, clampFont, type AuxKey, type StickyModifiers } from "@/lib/herdr-term-keys";
import { HerdrLiveTerminal, readStoredFontSize, type HerdrLiveTerminalHandle } from "./HerdrLiveTerminal";
import { HerdrTermKeyBar } from "./HerdrTermKeyBar";
import { HerdrTerminalReflow } from "./HerdrTerminalReflow";
import { HerdrXterm } from "./HerdrXterm";

// 终端抽屉（桌面）和手机工作台共用的「窗格屏幕」：实时流优先，轮询兜底。
//
//   视图 terminal：实时流（HerdrLiveTerminal）；流不可用（herdr 太旧 / 反复连不上）时
//                  自动退回旧的轮询 + 只读 xterm。
//   视图 reflow / raw：照旧轮询读屏（文本重排 / 原始字符），适合长输出阅读。
//
// 实时流活着的时候不轮询——那份读屏是 1000 行的 ansi 大包，3 秒一次纯属浪费。

export type HerdrViewMode = "terminal" | "reflow" | "raw";
const LINES = 1000;

export type HerdrPaneTerminal = ReturnType<typeof useHerdrPaneTerminal>;

export function useHerdrPaneTerminal({
  paneId,
  active,
  readOnly,
  pollMs,
}: {
  paneId: string | null;
  active: boolean;
  readOnly: boolean;
  pollMs: number;
}) {
  const [viewMode, setViewMode] = useState<HerdrViewMode>("terminal");
  const [live, setLive] = useState<{ paneId: string | null; s: HerdrStreamStatus; detail?: string }>({
    paneId: null,
    s: "connecting",
  });
  // 回退轮询按窗格记：换个窗格（可能在另一台机器 / 新版 herdr 上）重新试实时流。
  const [fallbackPane, setFallbackPane] = useState<string | null>(null);
  const fallback = fallbackPane !== null && fallbackPane === paneId;
  const liveMode = viewMode === "terminal" && !fallback;

  const [screen, setScreen] = useState<{ paneId: string; text: string; error: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [modifiers, setModifiers] = useState<StickyModifiers>(NO_MODIFIERS);
  const [selectMode, setSelectMode] = useState(false);
  const [fontSize, setFontSize] = useState<number | null>(null);
  const liveRef = useRef<HerdrLiveTerminalHandle | null>(null);
  // 回调 ref：hook 的返回值里不放 ref 对象本身（render 期间读 ref 会被 React 编译器拦）。
  const bindLive = useCallback((h: HerdrLiveTerminalHandle | null) => {
    liveRef.current = h;
  }, []);

  // 字号偏好只在浏览器里有：挂载后读一次。
  useEffect(() => {
    setFontSize(readStoredFontSize());
  }, []);

  const load = useCallback(
    async (id: string, mode: HerdrViewMode = viewMode) => {
      setLoading(true);
      try {
        const format = mode === "terminal" ? "ansi" : "text";
        const next = await readHerdrPane(id, LINES, format);
        setScreen({ paneId: id, text: next, error: null });
      } catch (err) {
        setScreen((prev) => ({
          paneId: id,
          text: prev?.paneId === id ? prev.text : "",
          error: err instanceof Error ? err.message : String(err),
        }));
      } finally {
        setLoading(false);
      }
    },
    [viewMode],
  );

  useEffect(() => {
    if (!paneId || !active || liveMode) return;
    const tick = () => {
      if (document.visibilityState === "visible") void load(paneId);
    };
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, pollMs);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [paneId, active, liveMode, load, pollMs]);

  const onLiveStatus = useCallback(
    (s: HerdrStreamStatus, detail?: string) => {
      setLive({ paneId, s, detail });
      if (s === "unsupported" && paneId) {
        setFallbackPane(paneId);
        toast("实时终端不可用，已改为定时读屏", { description: detail });
      }
    },
    [paneId],
  );

  const cycleViewMode = () => {
    const next: HerdrViewMode = viewMode === "terminal" ? "reflow" : viewMode === "reflow" ? "raw" : "terminal";
    setViewMode(next);
    setSelectMode(false);
    if (paneId && (next !== "terminal" || fallback)) void load(paneId, next);
  };

  /** 顶栏的刷新：实时流 = 重连（拿一帧全新的整屏）；轮询 = 立即读一次。 */
  const refresh = () => {
    if (!paneId) return;
    if (liveMode) liveRef.current?.reconnect();
    else void load(paneId);
  };

  /** 输入框 / 快捷命令发完后：轮询模式立即补读一次，实时流自己会推。 */
  const afterSend = () => {
    if (paneId && !liveMode) setTimeout(() => void load(paneId), 300);
  };

  const pressKey = async (key: AuxKey) => {
    if (!paneId || readOnly) return;
    if (liveMode) {
      liveRef.current?.sendBytes(key.bytes);
      return;
    }
    try {
      await sendHerdrCommand(paneId, "", [key.herdrKey]);
      afterSend();
    } catch (err) {
      toast.error(`按键 ${key.label} 没发出去`, { description: err instanceof Error ? err.message : String(err) });
    }
  };

  return {
    paneId,
    viewMode,
    cycleViewMode,
    liveMode,
    fallback,
    liveStatus: live.paneId === paneId ? live : { paneId, s: "connecting" as HerdrStreamStatus },
    onLiveStatus,
    bindLive,
    /** 事件处理里用：实时终端当前的行数 / 实际字号。 */
    liveRows: () => liveRef.current?.grid().rows ?? null,
    liveFont: () => liveRef.current?.appliedFontSize() ?? null,
    screen: screen?.paneId === paneId ? screen : null,
    loading,
    refresh,
    afterSend,
    pressKey,
    readOnly,
    modifiers,
    toggleModifier: (id: keyof StickyModifiers) => setModifiers((m) => ({ ...m, [id]: !m[id] })),
    consumeModifiers: () => setModifiers(NO_MODIFIERS),
    selectMode,
    setSelectMode,
    fontSize,
    setFontSize,
  };
}

const STATUS_TEXT: Record<HerdrStreamStatus, string> = {
  connecting: "连接中",
  live: "实时",
  reconnecting: "重连中",
  offline: "离线",
  unsupported: "轮询",
};

/** 顶栏上的连接状态：实时 / 连接中 / 重连中 / 离线；回退后显示「轮询」。 */
export function HerdrLiveStatusPill({ t }: { t: HerdrPaneTerminal }) {
  if (t.viewMode !== "terminal") return null;
  const s: HerdrStreamStatus = t.fallback ? "unsupported" : t.liveStatus.s;
  const dot =
    s === "live" ? "bg-positive" : s === "offline" ? "bg-danger" : s === "unsupported" ? "bg-ink-faint" : "bg-warn animate-pulse motion-reduce:animate-none";
  return (
    <span
      role="status"
      title={t.liveStatus.detail ?? (s === "unsupported" ? "实时流不可用，按时读屏" : undefined)}
      className="flex shrink-0 items-center gap-1 rounded-full border border-line px-1.5 py-0.5 font-mono text-nano text-ink-muted"
    >
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", dot)} />
      {STATUS_TEXT[s]}
    </span>
  );
}

/** 屏幕区：实时终端 / 轮询 xterm / 重排 / 原始。 */
export function HerdrPaneScreen({ t, mobile }: { t: HerdrPaneTerminal; mobile?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const own = t.screen;

  // 贴底：用户没往上翻时，新内容进来自动滚到底（重排 / 原始视图）。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [own]);

  if (!t.paneId) return null;

  return (
    <div className="relative m-0 flex min-h-0 w-full min-w-0 max-w-full flex-1 flex-col overflow-hidden bg-[#0a0b10]">
      {t.liveMode ? (
        <HerdrLiveTerminal
          key={t.paneId}
          onHandle={t.bindLive}
          paneId={t.paneId}
          readOnly={t.readOnly}
          onStatus={t.onLiveStatus}
          modifiers={t.modifiers}
          onModifiersConsumed={t.consumeModifiers}
          selectMode={t.selectMode}
          fontSize={t.fontSize}
          onFontSizeChange={t.setFontSize}
        />
      ) : own?.error ? (
        <div className="p-3 font-medium text-danger">读屏暂不可用：{own.error}</div>
      ) : !own?.text ? (
        <div className="p-3 text-ink-faint">正在读取…</div>
      ) : t.viewMode === "terminal" ? (
        <HerdrXterm ansiText={own.text} />
      ) : (
        <div
          ref={scrollRef}
          data-herdr-drawer-screen
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
            stickRef.current = atBottom;
            setIsScrolledUp(!atBottom);
          }}
          className={cn(
            "m-0 min-h-0 w-full min-w-0 max-w-full flex-1 overflow-y-auto overflow-x-hidden font-mono leading-relaxed select-text",
            mobile ? "p-2.5 text-[11.5px]" : "p-3 text-nano",
          )}
        >
          <HerdrTerminalReflow text={own.text} raw={t.viewMode === "raw"} />
        </div>
      )}

      {/* 往上翻时提示回到底部（重排 / 原始视图） */}
      {t.viewMode !== "terminal" && isScrolledUp && (
        <button
          type="button"
          onClick={() => {
            const el = scrollRef.current;
            if (!el) return;
            el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
            stickRef.current = true;
            setIsScrolledUp(false);
          }}
          className="absolute bottom-3 right-3 z-20 flex items-center gap-1 rounded-full border border-line-strong bg-surface-raised/95 px-3 py-1 font-mono text-label font-medium text-ink shadow-lg backdrop-blur-sm active:bg-surface-muted"
        >
          <span>↓ 回到底部</span>
        </button>
      )}
    </div>
  );
}

/** 屏幕下方的工具条（选择文本 / 复制屏幕 / 字号）+ 辅助键栏。 */
export function HerdrPaneControls({ t, variant }: { t: HerdrPaneTerminal; variant: "full" | "compact" }) {
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);

  // 复制屏幕：走读屏接口拿纯文本（和终端里看到的一致，不含颜色）。fetch 之后浏览器
  // 可能已经不认这是「用户手势」了，复制失败就弹框让用户自己选中复制。
  const copyScreen = async () => {
    if (!t.paneId) return;
    setCopying(true);
    let text = "";
    try {
      const rows = (t.liveMode ? t.liveRows() : null) ?? 60;
      text = await readHerdrPane(t.paneId, rows, "text");
      await copyText(text);
      toast.success("已复制屏幕文本");
    } catch (err) {
      if (text) setCopyFallback(text);
      else toast.error("读屏失败，没能复制", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setCopying(false);
    }
  };

  const tool =
    "press flex h-7 shrink-0 items-center gap-1 rounded-field border border-[#24283c] bg-[#141624] px-2 text-nano text-[#a0a8be] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-40 aria-pressed:border-accent aria-pressed:text-accent-ink";
  const font = t.fontSize;
  const bump = (d: number) => {
    // 从自动切到手动时以当前自动字号为起点，避免一下跳回 12。
    const base = font ?? t.liveFont() ?? 12;
    t.setFontSize(clampFont(base + d));
  };

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-[#1a1d2b] bg-[#0c0e14] px-2 py-1 [scrollbar-width:none]">
        {t.liveMode && (
          <button
            type="button"
            aria-pressed={t.selectMode}
            onClick={() => t.setSelectMode(!t.selectMode)}
            className={tool}
            title="盖一层纯文本，用系统选区选中复制"
          >
            <Icon icon={TextSelect} size="sm" />
            选择文本
          </button>
        )}
        <button type="button" onClick={() => void copyScreen()} disabled={copying} className={tool} title="把当前屏幕的纯文本复制到剪贴板">
          <Icon icon={ClipboardCopy} size="sm" />
          复制屏幕
        </button>
        {t.liveMode && (
          <div className="ml-auto flex shrink-0 items-center gap-1" role="group" aria-label="终端字号">
            <button type="button" aria-label="缩小字号" className={tool} disabled={font !== null && font <= FONT_MIN} onClick={() => bump(-1)}>
              A−
            </button>
            <button
              type="button"
              aria-pressed={font === null}
              aria-label={font === null ? "字号：自动适配" : `字号 ${font}px，点击恢复自动适配`}
              className={cn(tool, "min-w-12 justify-center font-mono")}
              onClick={() => t.setFontSize(null)}
            >
              {font === null ? "自动" : `${font}px`}
            </button>
            <button type="button" aria-label="放大字号" className={tool} disabled={font !== null && font >= FONT_MAX} onClick={() => bump(1)}>
              A+
            </button>
          </div>
        )}
      </div>
      <HerdrTermKeyBar
        variant={variant}
        disabled={t.readOnly}
        modifiers={t.modifiers}
        showModifiers={variant === "full" && t.liveMode}
        onToggleModifier={t.toggleModifier}
        onKey={(k) => void t.pressKey(k)}
      />
      {copyFallback !== null && (
        <Modal onClose={() => setCopyFallback(null)} title="复制屏幕文本">
          <div className="flex flex-col gap-2 p-4">
            <p className="text-ui text-ink-muted">浏览器不允许直接写剪贴板（非 https 访问时常见），请手动全选复制：</p>
            <textarea
              readOnly
              aria-label="屏幕文本"
              value={copyFallback}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              className="h-64 w-full resize-none rounded-field border border-line bg-surface-canvas p-2 font-mono text-nano text-ink"
            />
            <div className="flex justify-end">
              <Button variant="secondary" size="sm" onClick={() => setCopyFallback(null)}>
                关闭
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
