// ui-guard-allow-file(hex): terminal high contrast theme
"use client";

import { useState } from "react";
import {
  ChevronDown,
  MessagesSquare,
  Plus,
  RotateCcw,
} from "lucide-react";
import {
  Button,
  Icon,
  IconButton,
  Spinner,
  StatusDot,
  toast,
} from "@/components/ui";
import {
  useCurrentHerdrPane,
  useHerdrConsole,
} from "@/hooks/useHerdrConsole";
import { refreshHerdrFleet } from "@/hooks/useHerdrFleet";
import { useIsMobile } from "@/hooks/useIsMobile";
import { createHerdrTab, sendHerdrCommand } from "@/lib/herdr-actions";
import { useHerdrConsoleStore } from "@/stores/herdrConsoleStore";
import { useSessionStore } from "@/stores/sessionStore";
import { HerdrLiveStatusPill, HerdrPaneControls, HerdrPaneScreen, useHerdrPaneTerminal } from "./HerdrPaneTerminal";

const POLL_MS = 2500;

// 手机全屏终端工作台：默认实时终端（能直接用软键盘打字，辅助键栏补 Esc/Ctrl/方向键），
// 实时流不可用时退回轮询读屏。和桌面抽屉共用 HerdrPaneTerminal。

export function HerdrMobileWorkbench() {
  const hc = useHerdrConsole();
  const current = useCurrentHerdrPane(hc.panes);
  // openDrawer 会同时置 mobileTerminalView（一个动作两端都能打开），桌面上要靠这里挡住：
  // 否则桌面同时出抽屉和这块全屏工作台，还会对同一窗格开两条实时流。
  const isMobile = useIsMobile();
  const active = useHerdrConsoleStore((s) => s.mobileTerminalView) && isMobile === true;
  const explicit = useHerdrConsoleStore((s) => s.drawerPaneId);
  const close = () => useHerdrConsoleStore.getState().setMobileTerminalView(false);
  const toggleFleetPicker = useHerdrConsoleStore((s) => s.toggleFleetPicker);
  const providerCatalog = useSessionStore((s) => s.providerCatalog);

  const target = explicit
    ? hc.panes.find((p) => p.paneId === explicit && p.lane !== "off") ?? null
    : current;

  const [sending, setSending] = useState<string | null>(null);
  const [customCmd, setCustomCmd] = useState("");
  const paneId = target?.paneId ?? null;
  const term = useHerdrPaneTerminal({
    paneId,
    active,
    readOnly: hc.readOnly || !hc.available,
    pollMs: POLL_MS,
  });

  if (!active || !target) return null;

  const executeCmd = async (cmd: string) => {
    if (!cmd.trim() || !target) return;
    setSending("cmd");
    try {
      await sendHerdrCommand(target.paneId, cmd.trim(), ["Enter"]);
      setCustomCmd("");
      term.afterSend();
    } catch (err) {
      toast.error(`发送失败: ${cmd}`, {
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
      className="dark fixed inset-0 z-50 flex flex-col bg-[#0a0b10] text-[#e4e6ee] ui-enter-fade"
      style={{
        colorScheme: "dark",
        paddingTop: "var(--safe-top, 0px)",
        paddingBottom: "max(var(--safe-bottom, 0px), 8px)",
      }}
    >
      {/* 1. 极简薄顶栏 (Mobile Topbar) */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-[#1e2232] bg-[#0e1017] px-2.5 text-ui">
        {/* 会话切换胶囊：点击直接呼出 Fleet Switcher */}
        <button
          type="button"
          onClick={toggleFleetPicker}
          className="flex max-w-[190px] items-center gap-1.5 rounded-full border border-[#24283b] bg-[#141622] px-2.5 py-1 text-xs font-medium text-ink-strong active:bg-[#1a1e2e]"
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
              className="flex items-center gap-1 rounded-full border border-accent-line/60 bg-accent-muted/30 px-2 py-0.5 text-nano font-medium text-accent-ink"
              title="切换到结构化对话阅读流"
            >
              <Icon icon={MessagesSquare} size="sm" />
              <span>对话</span>
            </button>
          )}

          <HerdrLiveStatusPill t={term} />

          <button
            type="button"
            title="切换真实终端(xterm)、重排卡片与原始字符"
            onClick={term.cycleViewMode}
            className="rounded-field border border-[#25293d] bg-[#141624] px-2 py-0.5 font-mono text-nano text-[#8e96ac] hover:text-ink active:bg-[#1a1e2e]"
          >
            {term.viewMode === "terminal" ? "终端" : term.viewMode === "reflow" ? "重排" : "原始"}
          </button>

          <IconButton label={term.liveMode ? "重新连接" : "刷新"} size="sm" onClick={term.refresh} disabled={term.loading}>
            <Icon icon={RotateCcw} size="sm" className={term.loading ? "animate-spin motion-reduce:animate-none" : undefined} />
          </IconButton>

          <IconButton label="新建Tab" size="sm" onClick={handleCreateTab}>
            <Icon icon={Plus} size="sm" />
          </IconButton>
        </div>
      </header>

      {/* 2. 满屏打平终端视口 (Flat Full-Bleed Terminal Screen) */}
      <HerdrPaneScreen t={term} mobile />

      {/* 3. 底部操作栏：本地中文输入框 (Composer) */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void executeCmd(customCmd);
        }}
        className="flex w-full shrink-0 items-center gap-1.5 border-t border-[#1e2232] bg-[#0e1017] px-2.5 py-1.5"
      >
        <input
          type="text"
          value={customCmd}
          onChange={(e) => setCustomCmd(e.target.value)}
          placeholder="输入命令或选择下方模型..."
          className="min-w-0 flex-1 rounded-field border border-[#24283c] bg-[#141624] px-2.5 py-1 font-mono text-ui text-ink outline-none focus:border-accent"
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
      <div className="flex w-full shrink-0 items-center gap-1.5 overflow-x-auto border-t border-[#1a1d2b] bg-[#0c0e14] px-2.5 py-1 text-nano">
        <span className="shrink-0 text-ink-faint">选模型:</span>
        {providerCatalog.map((p) => {
          const modelName = p.shortLabel || p.id.split(":").pop() || p.id;
          return (
            <button
              key={p.id}
              type="button"
              title={`填入: llm ${modelName}`}
              onClick={() => setCustomCmd(`llm ${modelName}`)}
              className="shrink-0 rounded-field border border-[#222638] bg-[#141624] px-2 py-0.5 font-mono text-[11px] text-[#8e96ac] transition-colors hover:border-accent hover:text-ink active:bg-accent-muted"
            >
              llm {modelName}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => void executeCmd("git status")}
          className="shrink-0 rounded-field border border-[#222638] bg-[#141624] px-2 py-0.5 font-mono text-[11px] text-[#8e96ac] hover:border-accent hover:text-ink"
        >
          git status
        </button>
        <button
          type="button"
          onClick={() => void executeCmd("clear")}
          className="shrink-0 rounded-field border border-[#222638] bg-[#141624] px-2 py-0.5 font-mono text-[11px] text-[#8e96ac] hover:border-accent hover:text-ink"
        >
          clear
        </button>
      </div>

      {/* 5. 工具条 + 辅助键栏（粘滞 Ctrl/Alt/⇧、方向键长按连发） */}
      <HerdrPaneControls t={term} variant="full" />
    </div>
  );
}
