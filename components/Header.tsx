"use client";
import { useEffect, useMemo, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { ModelPicker } from "./ModelPicker";
import { ExportMenu } from "./ExportMenu";
import { ModeBadge } from "./ModeBadge";
import { ThemeMenu } from "./ThemeMenu";
import { Popover } from "@/components/ui/Popover";
import { Modal } from "@/components/ui/Modal";
import { IconButton } from "@/components/ui/IconButton";
import { Button } from "@/components/ui/Button";
import { MobileOverflowMenu } from "@/components/MobileOverflowMenu";
import {
  setDesktopModeOverride,
  useIsNarrowViewport,
} from "@/hooks/useIsMobile";
import { useScrollHideState } from "@/hooks/useScrollHide";
import { formatTokens } from "@/lib/format-tokens";
import { contextWindowFor } from "@/lib/llm";
import { ctxTokensOf, findLineageCtxTurn } from "@/lib/context-usage";
import type { ChatNode } from "@/lib/types";

// The 🧠 context-occupancy % uses a per-provider window (contextWindowFor),
// resolved in-component from the current model — see lib/llm/providers.ts.
// (The CLI stream carries no real window field, so it's a per-model lookup.)

// In project mode every node under a root resumes the same claude session,
// so the model's working memory at any moment ≈ the input bundle of the
// most recent turn that actually reported tokens. cache_read carries the
// prior history bytes; cache_creation is whatever just got added.
function findRoot(nodeId: string, nodes: Record<string, ChatNode>): ChatNode | null {
  let cur: ChatNode | undefined = nodes[nodeId];
  for (let i = 0; i < 1000 && cur; i++) {
    if (!cur.parentId) return cur;
    cur = nodes[cur.parentId];
  }
  return null;
}

function ContextUsageDetails({
  rootLabel,
  tokens,
  percent,
  contextWindow,
  actionable,
  onStartFresh,
}: {
  rootLabel: string;
  tokens: number;
  percent: number;
  contextWindow: number;
  actionable: boolean;
  onStartFresh: () => void;
}) {
  return (
    <>
      <div className="text-ui font-semibold text-ink-strong flex items-center gap-1.5">
        🧠 上下文占用 {percent.toFixed(1)}%
      </div>
      <div className="text-ui text-ink-muted mt-1.5 leading-relaxed">
        当前 root「{rootLabel}」的 Claude 会话已用 {formatTokens(tokens)} /{" "}
        {formatTokens(contextWindow)} tokens。占用越高，模型越慢、缓存越难增长。
      </div>
      {actionable ? (
        <>
          <div className="text-label text-ink-faint mt-1.5 leading-relaxed">
            claude CLI 的{" "}
            <code className="px-1 rounded bg-surface-muted">/compact</code>{" "}
            在这里暂无原生支持。可改为开一条「新话题」——全新上下文的根问答，等价{" "}
            <code className="px-1 rounded bg-surface-muted">/clear</code>。
          </div>
          <Button
            variant="primary"
            className="mt-2.5 w-full"
            onClick={onStartFresh}
          >
            🧹 开新话题（清空上下文）
          </Button>
        </>
      ) : (
        <div className="text-label text-ink-faint mt-1.5 leading-relaxed">
          占用尚低，无需处理。≥50% 时这里会提供「🧹 开新话题」一键清空上下文。
        </div>
      )}
    </>
  );
}

export function Header({ isMobile }: { isMobile: boolean }) {
  const isNarrowViewport = useIsNarrowViewport();
  const { isHidden: scrollHidden, reveal: revealScrollChrome } =
    useScrollHideState();
  const session = useSessionStore((s) => s.session);
  const nodes = useSessionStore((s) => s.nodes);
  const activeNodeId = useSessionStore((s) => s.activeNodeId);
  const noteCount = useSessionStore((s) => s.notes.length);
  const setNotesOpen = useSessionStore((s) => s.setNotesOpen);
  const setSearchOpen = useSessionStore((s) => s.setSearchOpen);
  const setOutlineOpen = useSessionStore((s) => s.setOutlineOpen);
  const setMobileNavOpen = useSessionStore((s) => s.setMobileNavOpen);
  const chatEnhanced = useSessionStore((s) => s.chatEnhanced);
  const setChatEnhanced = useSessionStore((s) => s.setChatEnhanced);
  const setComposeRootOpen = useSessionStore((s) => s.setComposeRootOpen);
  const setWorkspaceFilesOpen = useSessionStore((s) => s.setWorkspaceFilesOpen);
  const provider = useSessionStore((s) => s.provider);
  const nodeCount = Object.keys(nodes).length;
  const contextWindow = contextWindowFor(provider);
  // Aggregate four buckets independently — total input vs total output vs
  // total cache leverage. Computed via useMemo (NOT inside the Zustand
  // selector) because returning a fresh object from a selector defeats
  // its referential-equality bail-out and triggers an infinite render
  // loop ("getSnapshot should be cached"). The selector returns the
  // stable nodes map; useMemo only recomputes when that ref changes.
  const totals = useMemo(
    () =>
      Object.values(nodes).reduce(
        (acc, n) => {
          acc.input += n.tokenCount.input;
          acc.output += n.tokenCount.output;
          acc.cacheRead += n.tokenCount.cacheRead;
          acc.cacheCreation += n.tokenCount.cacheCreation;
          return acc;
        },
        { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      ),
    [nodes],
  );

  // Project-mode context occupancy for the currently-focused root's claude
  // session. Skipped in chat because every turn is independent
  // there — % has no meaning.
  const ctx = useMemo(() => {
    if (session?.mode !== "project") return null;
    if (!activeNodeId) return null;
    const root = findRoot(activeNodeId, nodes);
    if (!root) return null;
    const latest = findLineageCtxTurn(activeNodeId, nodes);
    if (!latest) return null;
    const tokens = ctxTokensOf(latest);
    return {
      tokens,
      percent: Math.min(100, (tokens / contextWindow) * 100),
      rootId: root.id,
      rootLabel: root.topicLabel ?? root.question.slice(0, 30),
    };
  }, [session?.mode, activeNodeId, nodes, contextWindow]);

  // Three-band color: muted → amber → rose. 80% is when context pressure
  // usually starts mattering (model gets slower; cache stops growing).
  const ctxTone =
    ctx == null
      ? ""
      : ctx.percent >= 80
        ? "text-danger"
        : ctx.percent >= 50
          ? "text-warn"
          : "text-ink-muted";

  // B3 (/compact degradation): once the focused root's claude session is
  // ≥ 50% full, the 🧠 badge becomes a clickable affordance that opens a
  // small popover explaining context pressure + a one-click "开新话题清空"
  // shortcut (which spawns a fresh-context root — there is no native compact
  // in the claude CLI / @smokingmouse/agent SDK, confirmed by spike). Below 50% the
  // badge stays a plain non-interactive readout to avoid nagging.
  const [ctxPopoverOpen, setCtxPopoverOpen] = useState(false);
  const [mobileOverflowOpen, setMobileOverflowOpen] = useState(false);
  const ctxActionable = ctx != null && ctx.percent >= 50;

  const [gwMe, setGwMe] = useState<{ role?: string } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/__gw/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (alive && data?.role) setGwMe(data);
      })
      .catch(() => {
        // 单人版或网关不可达：静默降级
      });
    return () => {
      alive = false;
    };
  }, []);

  if (isMobile) {
    const title = session?.title.trim() || "新会话";
    const headerHidden = scrollHidden;
    return (
      <>
        <header
          data-mobile-header
          data-safe-area="header"
          data-header-hidden={headerHidden ? "true" : undefined}
          aria-hidden={headerHidden ? true : undefined}
          inert={headerHidden ? true : undefined}
          className={`fixed top-0 inset-x-0 h-12 bg-surface-canvas/85 backdrop-blur border-b border-line flex items-center px-1 z-40 gap-1 transition-transform duration-200 motion-reduce:transition-none ${
            headerHidden ? "pointer-events-none" : ""
          }`}
          style={{
            height: "var(--trellis-header-h)",
            paddingTop: "var(--safe-top)",
            transform: headerHidden ? "translateY(-100%)" : undefined,
          }}
        >
          <IconButton
            label="会话列表"
            data-mobile-target="header-session-drawer"
            onClick={() => setMobileNavOpen(true)}
            className="h-11 w-11 p-0"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </IconButton>
          <div className="min-w-0 flex-1 px-1 text-center">
            <span
              className="block truncate text-sm font-medium text-ink-strong"
              title={title}
            >
              {title}
            </span>
          </div>
          <IconButton
            label="更多功能"
            data-mobile-target="header-overflow"
            aria-expanded={mobileOverflowOpen}
            onClick={() => setMobileOverflowOpen(true)}
            className="h-11 w-11 p-0 text-xl tracking-widest"
          >
            <span aria-hidden>…</span>
          </IconButton>
        </header>
        {headerHidden && (
          <button
            type="button"
            data-header-reveal
            aria-label="显示顶部栏"
            onClick={revealScrollChrome}
            className="fixed top-0 inset-x-0 z-50 border-0 bg-surface-canvas p-0"
            style={{ height: "max(var(--safe-top), 24px)" }}
          />
        )}
        <MobileOverflowMenu
          open={mobileOverflowOpen}
          onClose={() => setMobileOverflowOpen(false)}
          showAdmin={gwMe?.role === "admin"}
          contextUsage={ctx ? { percent: ctx.percent } : null}
          onOpenContext={() => {
            setMobileOverflowOpen(false);
            setCtxPopoverOpen(true);
          }}
        />
        {ctx && ctxPopoverOpen && (
          <Modal onClose={() => setCtxPopoverOpen(false)}>
            <section
              data-context-usage-dialog
              aria-label="上下文占用详情"
              className="p-4"
            >
              <div className="mb-2 flex justify-end">
                <IconButton
                  label="关闭上下文占用详情"
                  onClick={() => setCtxPopoverOpen(false)}
                >
                  ×
                </IconButton>
              </div>
              <ContextUsageDetails
                rootLabel={ctx.rootLabel}
                tokens={ctx.tokens}
                percent={ctx.percent}
                contextWindow={contextWindow}
                actionable={ctxActionable}
                onStartFresh={() => {
                  setCtxPopoverOpen(false);
                  setComposeRootOpen(true);
                }}
              />
            </section>
          </Modal>
        )}
      </>
    );
  }

  const narrowDesktopOverride = isNarrowViewport;

  return (
    <header
      data-safe-area="header"
      className="fixed top-0 inset-x-0 h-12 bg-surface-canvas/85 backdrop-blur border-b border-line flex items-center px-3 sm:px-4 z-40 gap-2 sm:gap-3"
      style={{
        height: "var(--trellis-header-h)",
        paddingTop: "var(--safe-top)",
      }}
    >
      <div className="flex items-center gap-2 shrink-0">
        {/* Mobile-only: open the session-list drawer. The left sidebar is
            hidden on phones, so this is the only way to see / switch between
            sessions there. */}
        <IconButton
          label="会话列表"
          data-mobile-target="header-session-drawer"
          onClick={() => setMobileNavOpen(true)}
          className="md:hidden -ml-1"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </IconButton>
        {/* 品牌渐变固定色（不随主题换肤）：#6366f1 → #d946ef → #fbbf24 */}
        <div className="w-6 h-6 rounded bg-gradient-to-br from-[#6366f1] via-[#d946ef] to-[#fbbf24]" />
        <span className="font-semibold tracking-tight hidden sm:inline">Trellis</span>
        <span className="text-ink-faint hidden sm:inline">/</span>
      </div>
      {/* The session switcher now lives in the always-visible SessionTabs
          bar just below the Header (Wave 1). This spacer keeps the
          right-side controls pinned to the edge. */}
      <div className="flex-1 min-w-0" />
      <div className="flex items-center gap-2 sm:gap-3 text-xs text-ink-muted shrink-0">
        <IconButton
          label="搜索"
          title="搜索 (⌘P)"
          onClick={() => setSearchOpen(true)}
          className="px-2 py-1"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
        </IconButton>
        {session && (
          <>
            {/* 树形分支 icon——与左侧会话列表 ☰ 明确区分（移动端两个
                同形三横线曾并列 Header 两端，易混）。 */}
            {!narrowDesktopOverride && (
              <IconButton
                label="思维树"
                onClick={() => setOutlineOpen(true)}
                className="md:hidden px-2 py-1"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M6 3v12" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
              </IconButton>
            )}
            {session.mode === "chat" && (
              <button
                onClick={() => setChatEnhanced(!chatEnhanced)}
                title="增强模式：开启后 chat 能跑 skill + 联网（YOLO，无沙箱、能跑任意命令）。默认关 = 纯对话。"
                aria-label="增强模式"
                className={`px-2 py-1 rounded inline-flex items-center gap-1 transition-colors ${
                  chatEnhanced
                    ? /* boost 复用 warn hue */
                      "bg-warn-muted text-warn-ink"
                    : "text-ink-muted hover:bg-surface-muted"
                }`}
              >
                <span aria-hidden>⚡</span>
                <span className="hidden sm:inline text-label">
                  {chatEnhanced ? "增强·开" : "增强"}
                </span>
              </button>
            )}
            <span className="hidden md:inline">{nodeCount} 节点</span>
            <span className="hidden md:inline text-ink-faint">·</span>
            <span
              className="hidden md:inline-flex items-center gap-1.5 tabular-nums"
              title={`输入 ${totals.input} · 输出 ${totals.output} · 缓存命中 ${totals.cacheRead}${
                totals.cacheCreation > 0
                  ? ` · 缓存写入 ${totals.cacheCreation}`
                  : ""
              }`}
            >
              <span>↑{formatTokens(totals.input)}</span>
              <span>↓{formatTokens(totals.output)}</span>
              {(totals.cacheRead > 0 || totals.cacheCreation > 0) && (
                <span className="text-positive">
                  ⚡{formatTokens(totals.cacheRead)}
                  {totals.cacheCreation > 0
                    ? `+${formatTokens(totals.cacheCreation)}`
                    : ""}
                </span>
              )}
            </span>
            {ctx && (
              <>
                <span className="hidden md:inline text-ink-faint">·</span>
                {/* 恒为按钮形态（描边 + hover）——「静默从只读变可点」是
                    Session 53 批过的反模式；<50% 时 popover 只做只读解释，
                    ≥50% 才附「开新话题」动作。 */}
                <Popover
                  open={ctxPopoverOpen}
                  onClose={() => setCtxPopoverOpen(false)}
                  panelClassName="w-72 p-3 text-left"
                  trigger={
                    <button
                      onClick={() => setCtxPopoverOpen((v) => !v)}
                      className={`inline-flex items-center gap-1 tabular-nums rounded border border-line px-1.5 py-0.5 hover:bg-surface-muted transition-colors ${ctxTone}`}
                      title={`当前 root「${ctx.rootLabel}」的 Claude 会话占用 ${formatTokens(ctx.tokens)} / ${formatTokens(contextWindow)} tokens (${ctx.percent.toFixed(1)}%)。点击查看详情。`}
                      aria-label="上下文占用，点击查看详情"
                      aria-expanded={ctxPopoverOpen}
                    >
                      🧠 {ctx.percent < 10 ? ctx.percent.toFixed(1) : Math.round(ctx.percent)}%
                      {ctx.percent >= 80 && <span aria-hidden>⚠️</span>}
                    </button>
                  }
                >
                  <ContextUsageDetails
                    rootLabel={ctx.rootLabel}
                    tokens={ctx.tokens}
                    percent={ctx.percent}
                    contextWindow={contextWindow}
                    actionable={ctxActionable}
                    onStartFresh={() => {
                      setCtxPopoverOpen(false);
                      setComposeRootOpen(true);
                    }}
                  />
                </Popover>
              </>
            )}
            {/* Workspace-files drawer entry — only for sessions with a cwd
                (project). A dedicated button: hiding this behind
                the ModeBadge chip proved undiscoverable. */}
            {session.workspacePath && (
              <IconButton
                label="工作区文件"
                title="工作区文件（只读浏览）"
                onClick={() => setWorkspaceFilesOpen(true)}
                className="px-2 py-1"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </IconButton>
            )}
            <IconButton
              label="笔记"
              onClick={() => setNotesOpen(true)}
              className="px-2 py-1 gap-1.5"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
              {noteCount > 0 && (
                <span className="tabular-nums text-label">
                  {noteCount}
                </span>
              )}
            </IconButton>
            <ExportMenu />
          </>
        )}
        <ModeBadge />
        <ModelPicker />
        <ThemeMenu />
        {/* 自动化任务。S89 起它是管理台的一个 tab，但 Header 上这个 ⏱ **保留**。
            原计划是等任务日常入口转移到侧栏（spec 批 4）后删掉它、Header 收敛到一个 ⚙；
            但 S89 查真库发现 tasks / task_runs 全是 0 行（facts.md 第一条），批 4 已降级，
            而「入口太深」正是零使用的头号嫌疑 —— 这时候把入口改深是反着来的。
            删它的条件改成：任务真的被用起来、且侧栏有了替代入口。 */}
        <a
          href="/settings/tasks"
          title="自动化任务"
          aria-label="自动化任务"
          className="inline-flex items-center justify-center px-2 py-1 rounded-md text-ink-muted hover:text-ink hover:bg-surface-muted"
        >
          <span aria-hidden className="text-[13px] leading-none">
            ⏱
          </span>
        </a>
        {/* 管理员入口：调 GET /__gw/api/me 感知，role=admin 时露出 */}
        {gwMe?.role === "admin" && (
          <a
            href="/admin"
            title="管理后台"
            aria-label="管理后台"
            className="inline-flex items-center justify-center px-2 py-1 rounded-md text-ink-muted hover:text-ink hover:bg-surface-muted"
          >
            <span aria-hidden className="text-[13px] leading-none">
              🛡️
            </span>
          </a>
        )}
        {narrowDesktopOverride && (
          <button
            type="button"
            data-mobile-target="restore-mobile-mode"
            title="回手机版"
            aria-label="回手机版"
            onClick={() => {
              setDesktopModeOverride(false);
              window.location.reload();
            }}
            className="fixed right-1 top-1 z-50 flex h-10 items-center rounded-md border border-line bg-surface px-3 text-sm font-medium text-ink shadow-raise hover:bg-surface-muted"
          >
            回手机版
          </button>
        )}
        {/* 设置是整页而不是 popover：版本、落后的 commit、部署进度、失败日志，
            没有一样塞得进一个下拉。用 <a> 而不是 <Link> —— 从画布跳走时让浏览器
            真的换一页，别把一整棵 React Flow 的状态背着走。 */}
        <a
          href="/settings"
          title="设置"
          aria-label="设置"
          className="inline-flex items-center justify-center px-2 py-1 rounded-md text-ink-muted hover:text-ink hover:bg-surface-muted"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </a>
      </div>
    </header>
  );
}
