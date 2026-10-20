"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronDown,
  MessagesSquare,
  Plus,
  RotateCcw,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  Button,
  Icon,
  IconButton,
  Spinner,
  StatusDot,
  cn,
  toast,
} from "@/components/ui";
import {
  openHerdrConsolePane,
  useCurrentHerdrPane,
  useHerdrConsole,
} from "@/hooks/useHerdrConsole";
import { refreshHerdrFleet } from "@/hooks/useHerdrFleet";
import {
  createHerdrTab,
  readHerdrPane,
  sendHerdrCommand,
} from "@/lib/herdr-actions";
import { useHerdrConsoleStore } from "@/stores/herdrConsoleStore";
import { useSessionStore } from "@/stores/sessionStore";
import { HerdrTerminalReflow } from "./HerdrTerminalReflow";

const LINES = 1000;
const POLL_MS = 2500;

const KEYS: { label: string; key: string; title: string }[] = [
  { label: "Tab", key: "Tab", title: "Tab 自动补全" },
  { label: "Enter", key: "Enter", title: "回车" },
  { label: "Esc", key: "Escape", title: "Esc" },
  { label: "Ctrl-C", key: "ctrl+c", title: "Ctrl-C 中断" },
  { label: "↑", key: "up", title: "上方向键" },
  { label: "↓", key: "down", title: "下方向键" },
  { label: "1", key: "1", title: "按键 1" },
  { label: "2", key: "2", title: "按键 2" },
];

export function HerdrMobileWorkbench() {
  const hc = useHerdrConsole();
  const current = useCurrentHerdrPane(hc.panes);
  const active = useHerdrConsoleStore((s) => s.mobileTerminalView);
  const explicit = useHerdrConsoleStore((s) => s.drawerPaneId);
  const close = () => useHerdrConsoleStore.getState().setMobileTerminalView(false);
  const toggleFleetPicker = useHerdrConsoleStore((s) => s.toggleFleetPicker);
  const providerCatalog = useSessionStore((s) => s.providerCatalog);

  const target = explicit
    ? hc.panes.find((p) => p.paneId === explicit && p.lane !== "off") ?? null
    : current;

  const [screen, setScreen] = useState<{ paneId: string; text: string; error: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [rawMode, setRawMode] = useState(false);
  const [customCmd, setCustomCmd] = useState("");
  const [isScrolledUp, setIsScrolledUp] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const paneId = target?.paneId ?? null;

  const load = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const next = await readHerdrPane(id, LINES);
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
  }, []);

  useEffect(() => {
    if (!paneId || !active) return;
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
  }, [paneId, active, load]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [screen]);

  if (!active || !target) return null;

  const own = screen?.paneId === target.paneId ? screen : null;

  const executeCmd = async (cmd: string) => {
    if (!cmd.trim() || !target) return;
    setSending("cmd");
    try {
      await sendHerdrCommand(target.paneId, cmd.trim(), ["Enter"]);
      setCustomCmd("");
      setTimeout(() => void load(target.paneId), 200);
    } catch (err) {
      toast.error(`发送失败: ${cmd}`, {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSending(null);
    }
  };

  const pressKey = async (key: string, label: string) => {
    if (!target) return;
    setSending(key);
    try {
      await sendHerdrCommand(target.paneId, "", [key]);
      setTimeout(() => void load(target.paneId), 200);
    } catch (err) {
      toast.error(`按键 ${label} 失败`, {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSending(null);
    }
  };

  const handleCreateTab = async () => {
    try {
      const res = await createHerdrTab({
        workspaceId: target.workspaceId,
        cwd: target.cwd ?? undefined,
      });
      toast.success("已创建新终端 Tab");
      refreshHerdrFleet();
      if (res.paneId) {
        useHerdrConsoleStore.getState().openDrawer(res.paneId);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建失败");
    }
  };

  return (
    <div
      data-herdr-mobile-workbench
      className="fixed inset-0 z-40 flex flex-col bg-[#020203] text-ink ui-enter-fade"
      style={{
        paddingTop: "var(--safe-top, 0px)",
        paddingBottom: "max(var(--safe-bottom, 0px), 8px)",
      }}
    >
      {/* 1. 极简薄顶栏 (Mobile Topbar) */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line-strong bg-[#0d0f14] px-2 text-ui">
        {/* 会话切换胶囊：点击直接呼出 Fleet Switcher */}
        <button
          type="button"
          onClick={toggleFleetPicker}
          className="flex max-w-[190px] items-center gap-1.5 rounded-full border border-line-strong bg-surface-raised px-2.5 py-1 text-xs font-medium text-ink-strong active:bg-surface-muted"
        >
          {target.lane === "need" ? (
            <StatusDot tone="warn" className="ring-2 ring-warn-muted" />
          ) : target.lane === "run" ? (
            <Spinner size="sm" label={null} />
          ) : (
            <StatusDot tone="idle" />
          )}
          <span className="truncate">
            {target.tabLabel} · {target.title}
          </span>
          <Icon icon={ChevronDown} size="sm" className="shrink-0 text-ink-faint" />
        </button>

        {/* 右侧动作区：切回对话、重排切换、新建Tab */}
        <div className="flex items-center gap-1">
          {target.sessionId && (
            <button
              type="button"
              onClick={close}
              className="flex items-center gap-1 rounded-full border border-accent-line bg-accent-muted/40 px-2 py-0.5 text-nano font-medium text-accent-ink"
              title="切换到结构化对话阅读流"
            >
              <Icon icon={MessagesSquare} size="sm" />
              <span>对话</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setRawMode(!rawMode)}
            className="rounded-field border border-line bg-surface-raised px-1.5 py-0.5 font-mono text-nano text-ink-muted active:bg-surface-muted"
          >
            {rawMode ? "原始" : "重排"}
          </button>

          <IconButton label="刷新" size="sm" onClick={() => void load(target.paneId)} disabled={loading}>
            <Icon icon={RotateCcw} size="sm" className={loading ? "animate-spin" : undefined} />
          </IconButton>

          <IconButton label="新建Tab" size="sm" onClick={handleCreateTab}>
            <Icon icon={Plus} size="sm" />
          </IconButton>
        </div>
      </header>

      {/* 2. 满屏打平纯黑终端视口 (Flat Full-Bleed Terminal Screen) */}
      <div className="relative min-h-0 flex-1 flex flex-col bg-[#020204]">
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
            const atBottom = dist < 36;
            stickRef.current = atBottom;
            setIsScrolledUp(!atBottom);
          }}
          className="m-0 min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3 font-mono text-xs leading-relaxed select-text"
        >
          {own?.error ? (
            <div className="text-danger font-medium">读屏不可用：{own.error}</div>
          ) : own?.text ? (
            <HerdrTerminalReflow text={own.text} raw={rawMode} />
          ) : (
            <div className="flex h-32 items-center justify-center gap-2 text-ink-faint">
              <Spinner size="sm" label="正在连接终端流..." />
            </div>
          )}
        </div>

        {/* 往上翻时提示回到底部 */}
        {isScrolledUp && (
          <button
            type="button"
            onClick={() => {
              const el = scrollRef.current;
              if (el) {
                el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
                stickRef.current = true;
                setIsScrolledUp(false);
              }
            }}
            className="absolute bottom-3 right-3 z-20 flex items-center gap-1 rounded-full border border-line-strong bg-surface-raised/95 px-3 py-1 font-mono text-label font-medium text-ink shadow-lg backdrop-blur-sm active:bg-surface-muted"
          >
            <span>↓ 回到底部</span>
          </button>
        )}
      </div>

      {/* 3. 底部操作栏：本地中文输入框 (Composer) */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void executeCmd(customCmd);
        }}
        className="flex shrink-0 items-center gap-1.5 border-t border-line-strong bg-[#0d0f14] px-2.5 py-1.5"
      >
        <input
          type="text"
          value={customCmd}
          onChange={(e) => setCustomCmd(e.target.value)}
          placeholder="输入命令或选择下方模型..."
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

      {/* 4. 模型快捷芯片行 */}
      <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-t border-line bg-[#0d0f14] px-2.5 py-1 text-nano">
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
          className="shrink-0 rounded-field border border-line bg-surface-raised px-2 py-0.5 font-mono text-ink-muted hover:border-accent"
        >
          git status
        </button>
        <button
          type="button"
          onClick={() => void executeCmd("clear")}
          className="shrink-0 rounded-field border border-line bg-surface-raised px-2 py-0.5 font-mono text-ink-muted hover:border-accent"
        >
          clear
        </button>
      </div>

      {/* 5. 常驻物理级辅助按键条 (Keybar) */}
      <div className="shrink-0 border-t border-line bg-[#08090d] px-2 py-1.5">
        <div className="flex flex-wrap gap-1">
          {KEYS.map(({ label, key, title }) => (
            <Button
              key={key}
              variant="secondary"
              size="sm"
              title={title}
              disabled={sending !== null}
              onClick={() => void pressKey(key, label)}
              className="font-mono text-nano"
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
