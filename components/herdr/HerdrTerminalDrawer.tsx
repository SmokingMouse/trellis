"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { RotateCcw, SquareTerminal, X } from "lucide-react";
import { Button, Icon, IconButton, toast } from "@/components/ui";
import { useCurrentHerdrPane, useHerdrConsole } from "@/hooks/useHerdrConsole";
import { useIsMobile } from "@/hooks/useIsMobile";
import { readHerdrPane, sendHerdrKeys } from "@/lib/herdr-actions";
import { useHerdrConsoleStore } from "@/stores/herdrConsoleStore";

export const HERDR_DRAWER_WIDTH = 380;
const POLL_MS = 3_000;
const LINES = 200;

// 底部一排按键：herdr send_keys 的键名（esc / ctrl+c 为 herdr 规范名）。
const KEYS: { label: string; key: string; title: string }[] = [
  { label: "1", key: "1", title: "发按键 1" },
  { label: "2", key: "2", title: "发按键 2" },
  { label: "3", key: "3", title: "发按键 3" },
  { label: "Enter", key: "Enter", title: "回车" },
  { label: "Esc", key: "Escape", title: "Esc：取消 / 打断" },
  { label: "↑", key: "up", title: "方向键上" },
  { label: "↓", key: "down", title: "方向键下" },
  { label: "Ctrl-C", key: "ctrl+c", title: "Ctrl-C：中断" },
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
  const target = explicit
    ? hc.panes.find((p) => p.paneId === explicit && p.lane !== "off") ?? null
    : current;
  const visible = open && Boolean(target);
  const paneId = visible ? target!.paneId : null;

  // 读屏结果带上来源窗格：切窗格时旧内容不串台（只显示属于当前目标的那份）。
  const [screen, setScreen] = useState<{ paneId: string; text: string; error: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);

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
  const keysDisabled = shell || hc.readOnly || !hc.available;
  const press = async (key: string, label: string) => {
    setSending(key);
    try {
      await sendHerdrKeys(target.paneId, [key]);
      setTimeout(() => void load(target.paneId), 300);
    } catch (err) {
      toast.error(`按键 ${label} 没发出去`, { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setSending(null);
    }
  };

  return (
    <aside
      data-herdr-drawer={target.paneId}
      aria-label="Herdr 终端"
      className="fixed bottom-0 z-30 flex flex-col border-l border-line bg-surface-canvas max-md:inset-x-0 max-md:border-l-0 max-md:border-t"
      style={
        isMobile
          ? { top: "var(--trellis-header-h)" }
          : {
              top: "calc(5.25rem + var(--trellis-pending-h, 0px))",
              right: "var(--trellis-rp, 0px)",
              width: HERDR_DRAWER_WIDTH,
            }
      }
    >
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line pl-3 pr-2 text-ui">
        <Icon icon={SquareTerminal} size="sm" className="text-ink-muted" />
        <b className="font-medium text-ink-strong">终端</b>
        <span className="min-w-0 flex-1 truncate text-label text-ink-faint">
          {target.workspaceLabel} · {target.tabLabel} · {shell ? target.title : `最近 ${LINES} 行`}
        </span>
        <IconButton label="重新读屏" size="sm" onClick={() => void load(target.paneId)} disabled={loading}>
          <Icon icon={RotateCcw} size="sm" className={loading ? "animate-spin motion-reduce:animate-none" : undefined} />
        </IconButton>
        <IconButton label="关闭终端抽屉" shortcut={["⌥", "`"]} size="sm" onClick={close}>
          <Icon icon={X} size="sm" />
        </IconButton>
      </div>
      <pre
        ref={preRef}
        data-herdr-drawer-screen
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="code-surface m-0 min-h-0 flex-1 overflow-auto whitespace-pre p-3 font-mono text-nano leading-relaxed"
      >
        {own?.error ? `读屏暂不可用：${own.error}` : own?.text || "正在读取…"}
      </pre>
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
        {shell && (
          <p className="mt-1.5 text-label text-ink-faint">纯 shell 窗格只读：Trellis 只向 agent 窗格发按键。</p>
        )}
      </div>
    </aside>
  );
}
