// ui-guard-allow-file(hex): terminal high contrast theme
"use client";

import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, PanelRightClose, PanelRightOpen, RotateCcw, SquareTerminal, X } from "lucide-react";
import { Button, Icon, IconButton, cn, toast } from "@/components/ui";
import { useCurrentHerdrPane, useHerdrConsole } from "@/hooks/useHerdrConsole";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useGesturesEnabled, usePrefersReducedMotion, useSwipe } from "@/hooks/useSwipe";
import { sendHerdrCommand } from "@/lib/herdr-actions";
import { useHerdrConsoleStore } from "@/stores/herdrConsoleStore";
import { useSessionStore } from "@/stores/sessionStore";
import { HerdrLiveStatusPill, HerdrPaneControls, HerdrPaneScreen, useHerdrPaneTerminal } from "./HerdrPaneTerminal";

export const HERDR_DRAWER_WIDTH = 380;
/** 「加宽」：实时终端的网格就是真实窗格的网格，380px 塞 100+ 列字太小，给一个宽档。 */
const HERDR_DRAWER_WIDE = 760;
const POLL_MS = 3_000;
const LINES = 1000;

// 终端抽屉：默认是 herdr 窗格的实时终端（/herdr-stream，能直接打字，见 HerdrPaneTerminal）；
// 实时流不可用时退回每 3 秒读屏。另有重排 / 原始两种文本视图。
// 目标 = 显式指定的窗格（总览里的纯 shell / 「看原始输出」）或当前 Herdr 会话的窗格。
// 只观察：真实窗格的尺寸不动，Trellis 不接管进程。
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

  const keysDisabled = hc.readOnly || !hc.available;
  const term = useHerdrPaneTerminal({ paneId, active: visible && !isMobile, readOnly: keysDisabled, pollMs: POLL_MS });
  const [sending, setSending] = useState<string | null>(null);
  const [wide, setWide] = useState(false);
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

  const drawerWidth = wide ? HERDR_DRAWER_WIDE : HERDR_DRAWER_WIDTH;

  // 桌面端让出右侧宽度（与 --trellis-rp 同一模式：一个变量，多个消费者）。
  useEffect(() => {
    if (!visible || isMobile) return;
    const root = document.documentElement;
    root.style.setProperty("--trellis-herdr-dw", `${drawerWidth}px`);
    return () => {
      root.style.removeProperty("--trellis-herdr-dw");
    };
  }, [visible, isMobile, drawerWidth]);

  if (!visible || !target || isMobile) return null;
  const shell = target.lane === "shell";

  const executeCmd = async (cmd: string) => {
    if (!cmd.trim()) return;
    setSending("cmd");
    try {
      await sendHerdrCommand(target.paneId, cmd.trim(), ["Enter"]);
      setCustomCmd("");
      term.afterSend();
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
        "dark fixed bottom-0 z-30 flex flex-col border-l border-line bg-[#0a0b10] text-[#e4e6ee] max-md:inset-x-0 max-md:rounded-t-card max-md:border-l-0 max-md:border-t-2 max-md:border-accent max-md:shadow-[0_-16px_48px_rgba(0,0,0,0.95)]",
        isMobile && "ui-enter-slide-up",
      )}
      style={
        isMobile
          ? {
              colorScheme: "dark",
              top: mobileExpanded ? "calc(var(--trellis-header-h) + 0.5rem)" : "48vh",
              paddingBottom: "var(--safe-bottom)",
            }
          : {
              colorScheme: "dark",
              top: "calc(5.25rem + var(--trellis-pending-h, 0px))",
              right: "var(--trellis-rp, 0px)",
              width: drawerWidth,
            }
      }
    >
      <div
        ref={handleRef}
        data-herdr-drawer-handle
        className="relative flex h-10 shrink-0 items-center gap-1.5 border-b border-line-strong bg-[#12141a] pl-3 pr-2 text-ui max-md:h-12 max-md:touch-none"
      >
        {isMobile && (
          <span aria-hidden className="absolute left-1/2 top-1 h-1 w-9 -translate-x-1/2 rounded-full bg-line-strong" />
        )}
        <Icon icon={SquareTerminal} size="sm" className="text-accent" />
        <b className="font-semibold text-ink-strong">终端</b>
        <span className="min-w-0 flex-1 truncate text-label text-ink-faint">
          {target.workspaceLabel} · {target.tabLabel} · {shell || term.liveMode ? target.title : `最近 ${LINES} 行`}
        </span>
        <HerdrLiveStatusPill t={term} />
        {isMobile && (
          <IconButton
            label={mobileExpanded ? "半屏展示" : "全屏展示"}
            size="sm"
            onClick={() => setMobileExpanded(!mobileExpanded)}
          >
            <Icon icon={mobileExpanded ? Minimize2 : Maximize2} size="sm" />
          </IconButton>
        )}
        {!isMobile && (
          <IconButton label={wide ? "收窄抽屉" : "加宽抽屉"} size="sm" onClick={() => setWide(!wide)}>
            <Icon icon={wide ? PanelRightClose : PanelRightOpen} size="sm" />
          </IconButton>
        )}
        <button
          type="button"
          onClick={term.cycleViewMode}
          className="rounded-field border border-line bg-surface-raised px-1.5 py-0.5 font-mono text-nano text-ink-muted hover:border-line-strong hover:text-ink active:bg-surface-muted"
          title="切换真实终端(xterm)、重排优化与原始字符"
        >
          {term.viewMode === "terminal" ? "终端" : term.viewMode === "reflow" ? "重排" : "原始"}
        </button>
        <IconButton label={term.liveMode ? "重新连接" : "重新读屏"} size="sm" onClick={term.refresh} disabled={term.loading}>
          <Icon icon={RotateCcw} size="sm" className={term.loading ? "animate-spin motion-reduce:animate-none" : undefined} />
        </IconButton>
        <IconButton label="关闭终端抽屉" shortcut={["⌥", "`"]} size="sm" onClick={close}>
          <Icon icon={X} size="sm" />
        </IconButton>
      </div>
      <HerdrPaneScreen t={term} />

      {/* 命令行输入条：支持用户自主敲入任何命令 */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void executeCmd(customCmd);
        }}
        className="flex shrink-0 items-center gap-1.5 border-t border-line-strong bg-[#0c0d12] px-2.5 py-1.5"
      >
        <input
          type="text"
          value={customCmd}
          onChange={(e) => setCustomCmd(e.target.value)}
          placeholder="输入命令，如 llm claude-opus..."
          className="min-w-0 flex-1 rounded-field border border-line bg-surface-canvas px-2.5 py-1 font-mono text-ui text-ink outline-none focus:border-accent"
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
      <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-t border-line bg-[#0c0d12] px-2.5 py-1 text-nano">
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

      <HerdrPaneControls t={term} variant="compact" />
    </aside>
    </>
  );
}
