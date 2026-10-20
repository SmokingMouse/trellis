"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, RotateCcw, SquareTerminal, X } from "lucide-react";
import { Button, Icon, IconButton, cn, toast } from "@/components/ui";
import { useCurrentHerdrPane, useHerdrConsole } from "@/hooks/useHerdrConsole";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useGesturesEnabled, usePrefersReducedMotion, useSwipe } from "@/hooks/useSwipe";
import { readHerdrPane, sendHerdrCommand } from "@/lib/herdr-actions";
import { useHerdrConsoleStore } from "@/stores/herdrConsoleStore";
import { useSessionStore } from "@/stores/sessionStore";
import { HerdrTerminalReflow } from "./HerdrTerminalReflow";

export const HERDR_DRAWER_WIDTH = 380;
const POLL_MS = 3_000;
const LINES = 200;

// 底部一排按键：herdr send_keys 的键名（esc / ctrl+c 为 herdr 规范名）。
const KEYS: { label: string; key: string; title: string }[] = [
  { label: "Tab", key: "Tab", title: "Tab 自动补全" },
  { label: "Enter", key: "Enter", title: "回车" },
  { label: "Esc", key: "Escape", title: "Esc：取消 / 打断" },
  { label: "Ctrl-C", key: "ctrl+c", title: "Ctrl-C：中断" },
  { label: "↑", key: "up", title: "方向键上" },
  { label: "↓", key: "down", title: "方向键下" },
  { label: "1", key: "1", title: "发按键 1" },
  { label: "2", key: "2", title: "发按键 2" },
];

// 终端抽屉：读屏最近 200 行（打开时每 3 秒轮询、页面隐藏时暂停，另有手动刷新）+ 发按键。
// 目标 = 显式指定的窗格（总览里的纯 shell / 「看原始输出」）或当前 Herdr 会话的窗格。
// 镜像跟不上、或者想看 TUI 原貌时用它；Trellis 仍只转发按键，不接管进程。
export function HerdrTerminalDrawer() {
  const hc = useHerdrConsole();
  const current = useCurrentHerdrPane(hc.panes);
  const open = useHerdrConsoleStore((s) => s.drawerOpen);
  const explicit = useHerdrConsoleStore((s) => s.drawerPaneId);
  const close = useHerdrConsoleStore((s) => s.closeDrawer);
  const isMobile = useIsMobile();
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const providerCatalog = useSessionStore((s) => s.providerCatalog);
  const [customCmd, setCustomCmd] = useState("");
  const target = explicit
    ? hc.panes.find((p) => p.paneId === explicit && p.lane !== "off") ?? null
    : current;
  const visible = open && Boolean(target);
  const paneId = visible ? target!.paneId : null;

  // 读屏结果带上来源窗格：切窗格时旧内容不串台（只显示属于当前目标的那份）。
  const [screen, setScreen] = useState<{ paneId: string; text: string; error: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [rawMode, setRawMode] = useState(false);
  const preRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const sheetRef = useRef<HTMLElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const gestures = useGesturesEnabled();
  const reduced = usePrefersReducedMotion();

  // 手机底部 sheet：按住顶栏（把手 + 标题行）下滑关闭，不够阈值回弹。
  const moveSheet = (offset: number, animate: boolean) => {
    const el = sheetRef.current;
    if (!el) return;
    el.style.transition = animate && !reduced ? "transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1)" : "none";
    el.style.transform = offset > 0 ? `translateY(${offset}px)` : "";
  };
  useSwipe(handleRef, {
    enabled: Boolean(isMobile) && gestures && visible,
    bindKey: paneId,
    axis: "y",
    size: () => sheetRef.current?.clientHeight ?? 600,
    threshold: { ratio: 0.25, minDistance: 80, velocity: 0.5, minFlingDistance: 32 },
    onMove: (delta) => moveSheet(Math.max(0, delta), false),
    onEnd: ({ commit, size }) => {
      if (commit > 0) {
        moveSheet(size, true);
        setTimeout(() => {
          moveSheet(0, false);
          close();
        }, reduced ? 0 : 180);
      } else moveSheet(0, true);
    },
  });

  const load = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const next = await readHerdrPane(id, LINES);
      setScreen({ paneId: id, text: next, error: null });
    } catch (err) {
      setScreen((prev) => ({ paneId: id, text: prev?.paneId === id ? prev.text : "", error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!paneId) return;
    stickRef.current = true;
    const tick = () => {
      if (document.visibilityState === "visible") void load(paneId);
    };
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [paneId, load]);

  // 贴底：用户没往上翻时，新内容进来自动滚到底。
  useLayoutEffect(() => {
    const el = preRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [screen]);

  // 桌面端让出右侧宽度（与 --trellis-rp 同一模式：一个变量，多个消费者）。
  useEffect(() => {
    if (!visible || isMobile) return;
    const root = document.documentElement;
    root.style.setProperty("--trellis-herdr-dw", `${HERDR_DRAWER_WIDTH}px`);
    return () => {
      root.style.removeProperty("--trellis-herdr-dw");
    };
  }, [visible, isMobile]);

  if (!visible || !target) return null;
  const own = screen?.paneId === target.paneId ? screen : null;
  const shell = target.lane === "shell";
  const keysDisabled = hc.readOnly || !hc.available;

  const press = async (key: string, label: string) => {
    setSending(key);
    try {
      await sendHerdrCommand(target.paneId, "", [key]);
      setTimeout(() => void load(target.paneId), 300);
    } catch (err) {
      toast.error(`按键 ${label} 没发出去`, { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setSending(null);
    }
  };

  const executeCmd = async (cmd: string) => {
    if (!cmd.trim()) return;
    setSending("cmd");
    try {
      await sendHerdrCommand(target.paneId, cmd.trim(), ["Enter"]);
      setCustomCmd("");
      setTimeout(() => void load(target.paneId), 300);
    } catch (err) {
      toast.error(`发送命令失败: ${cmd}`, {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSending(null);
    }
  };

  return (
    <>
    {isMobile && (
      <div aria-hidden className="fixed inset-0 z-30 bg-scrim/40 ui-enter-fade" onClick={close} data-herdr-drawer-scrim />
    )}
    <aside
      ref={sheetRef}
      data-herdr-drawer={target.paneId}
      aria-label="Herdr 终端"
      className={cn(
        "fixed bottom-0 z-30 flex flex-col border-l border-line bg-surface-canvas max-md:inset-x-0 max-md:rounded-t-card max-md:border-l-0 max-md:border-t max-md:shadow-overlay",
        isMobile && "ui-enter-slide-up",
      )}
      style={
        isMobile
          ? {
              top: mobileExpanded ? "calc(var(--trellis-header-h) + 0.5rem)" : "48vh",
              paddingBottom: "var(--safe-bottom)",
            }
          : {
              top: "calc(5.25rem + var(--trellis-pending-h, 0px))",
              right: "var(--trellis-rp, 0px)",
              width: HERDR_DRAWER_WIDTH,
            }
      }
    >
      <div
        ref={handleRef}
        data-herdr-drawer-handle
        className="relative flex h-10 shrink-0 items-center gap-1.5 border-b border-line pl-3 pr-2 text-ui max-md:h-12 max-md:touch-none"
      >
        {isMobile && (
          <span aria-hidden className="absolute left-1/2 top-1 h-1 w-9 -translate-x-1/2 rounded-full bg-line-strong" />
        )}
        <Icon icon={SquareTerminal} size="sm" className="text-ink-muted" />
        <b className="font-medium text-ink-strong">终端</b>
        <span className="min-w-0 flex-1 truncate text-label text-ink-faint">
          {target.workspaceLabel} · {target.tabLabel} · {shell ? target.title : `最近 ${LINES} 行`}
        </span>
        {isMobile && (
          <IconButton
            label={mobileExpanded ? "半屏展示" : "全屏展示"}
            size="sm"
            onClick={() => setMobileExpanded(!mobileExpanded)}
          >
            <Icon icon={mobileExpanded ? Minimize2 : Maximize2} size="sm" />
          </IconButton>
        )}
        <button
          type="button"
          onClick={() => setRawMode(!rawMode)}
          className="rounded-field border border-line bg-surface-raised px-1.5 py-0.5 font-mono text-nano text-ink-muted hover:border-line-strong hover:text-ink active:bg-surface-muted"
          title="切换重排优化与原始字符"
        >
          {rawMode ? "原始" : "重排"}
        </button>
        <IconButton label="重新读屏" size="sm" onClick={() => void load(target.paneId)} disabled={loading}>
          <Icon icon={RotateCcw} size="sm" className={loading ? "animate-spin motion-reduce:animate-none" : undefined} />
        </IconButton>
        <IconButton label="关闭终端抽屉" shortcut={["⌥", "`"]} size="sm" onClick={close}>
          <Icon icon={X} size="sm" />
        </IconButton>
      </div>
      <div
        ref={preRef}
        data-herdr-drawer-screen
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="code-surface m-0 min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3 font-mono text-nano leading-relaxed select-text"
      >
        {own?.error ? (
          <div className="text-danger font-medium">读屏暂不可用：{own.error}</div>
        ) : own?.text ? (
          <HerdrTerminalReflow text={own.text} raw={rawMode} />
        ) : (
          <div className="text-ink-faint">正在读取…</div>
        )}
      </div>

      {/* 命令行输入条：支持用户自主敲入任何命令 */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void executeCmd(customCmd);
        }}
        className="flex shrink-0 items-center gap-1.5 border-t border-line bg-surface-canvas px-2.5 py-1.5"
      >
        <input
          type="text"
          value={customCmd}
          onChange={(e) => setCustomCmd(e.target.value)}
          placeholder="输入命令，如 llm claude-opus..."
          className="min-w-0 flex-1 rounded-field border border-line bg-surface px-2.5 py-1 font-mono text-ui text-ink outline-none focus:border-accent"
        />
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          disabled={!customCmd.trim() || sending !== null}
        >
          发送
        </Button>
      </form>

      {/* 快捷模型选择条：点击模型自动组装并填入 llm <model> */}
      <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-t border-line bg-surface px-2.5 py-1 text-nano">
        <span className="shrink-0 text-ink-faint">选模型:</span>
        {providerCatalog.map((p) => {
          const modelName = p.shortLabel || p.id.split(":").pop() || p.id;
          return (
            <button
              key={p.id}
              type="button"
              title={`填入: llm ${modelName}`}
              onClick={() => setCustomCmd(`llm ${modelName}`)}
              className="shrink-0 rounded-field border border-line bg-surface-raised px-2 py-0.5 font-mono text-ink-muted transition-colors hover:border-accent hover:text-ink active:bg-accent-muted"
            >
              llm {modelName}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => void executeCmd("git status")}
          className="shrink-0 rounded-field border border-line bg-surface-raised px-2 py-0.5 font-mono text-ink-muted hover:border-accent hover:text-ink"
        >
          git status
        </button>
        <button
          type="button"
          onClick={() => void executeCmd("clear")}
          className="shrink-0 rounded-field border border-line bg-surface-raised px-2 py-0.5 font-mono text-ink-muted hover:border-accent hover:text-ink"
        >
          clear
        </button>
      </div>

      <div className="shrink-0 border-t border-line px-2.5 py-2">
        <div className="flex flex-wrap gap-1">
          {KEYS.map(({ label, key, title }) => (
            <Button
              key={key}
              variant="secondary"
              size="sm"
              title={title}
              data-herdr-drawer-key={key}
              disabled={keysDisabled || sending !== null}
              onClick={() => void press(key, label)}
              className="font-mono"
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
    </aside>
    </>
  );
}
