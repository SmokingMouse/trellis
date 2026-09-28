"use client";
import { useEffect, useMemo, useState } from "react";
import {
  Bookmark,
  CalendarClock,
  ChevronRight,
  Download,
  Ellipsis,
  FolderOpen,
  Keyboard,
  Menu,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useSessionStore } from "@/stores/sessionStore";
import { ModelPicker } from "./ModelPicker";
import { ModeBadge } from "./ModeBadge";
import { ThemeMenu } from "./ThemeMenu";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  Kbd,
  Modal,
  Popover,
  Tooltip,
} from "@/components/ui";
import { MobileOverflowMenu } from "@/components/MobileOverflowMenu";
import {
  setDesktopModeOverride,
  useIsNarrowViewport,
} from "@/hooks/useIsMobile";
import { useScrollHideState } from "@/hooks/useScrollHide";
import { formatTokens } from "@/lib/format-tokens";
import { contextWindowFor } from "@/lib/llm";
import { ctxTokensOf, findLineageCtxTurn } from "@/lib/context-usage";
import { openKeyboardHelp } from "@/lib/shortcuts";
import {
  downloadFile,
  exportJSON,
  exportMarkdown,
  safeFilename,
} from "@/lib/export";
import type { ChatNode } from "@/lib/types";

// W4：Header 分三组（照 docs/ui-redesign/mockups/01-workbench.html）——
//   左 = 导航：侧栏开关 + 品牌 + 面包屑（工作区 › 会话名）
//   中 = 会话语境：模式 chip、模型选择、上下文用量（中性细进度条；token 明细收进浮层）
//   右 = 系统：搜索、主题、「更多」菜单（笔记 / 稍后再读 / 工作区文件 / 导出 /
//        增强模式 / 快捷键 / 自动化任务 / 管理后台）、设置
// 原先右侧约 12 个同权重控件 + ⚡🧠⏱🛡️ 一堆 emoji（⚡ 一符三义）在这里收口。
//
// 上下文占用用的是按模型查的窗口（contextWindowFor）—— CLI 流里没有窗口字段。
// Project 模式下同一话题的所有节点复用同一个 claude 会话，所以任一时刻的
// 工作记忆 ≈ 最近一轮上报过 token 的输入包（cache_read = 历史，
// cache_creation = 刚追加的）。
function findRoot(nodeId: string, nodes: Record<string, ChatNode>): ChatNode | null {
  let cur: ChatNode | undefined = nodes[nodeId];
  for (let i = 0; i < 1000 && cur; i++) {
    if (!cur.parentId) return cur;
    cur = nodes[cur.parentId];
  }
  return null;
}

type Totals = { input: number; output: number; cacheRead: number; cacheCreation: number };

function UsageStats({ totals, nodeCount }: { totals: Totals; nodeCount: number }) {
  const rows: [string, string][] = [
    ["输入", formatTokens(totals.input)],
    ["输出", formatTokens(totals.output)],
    ["缓存读取", formatTokens(totals.cacheRead)],
  ];
  if (totals.cacheCreation > 0) rows.push(["缓存写入", formatTokens(totals.cacheCreation)]);
  return (
    <div>
      <div className="flex items-center justify-between text-label text-ink-faint">
        <span>本会话累计</span>
        <span className="tabular-nums">{nodeCount} 个节点</span>
      </div>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-label">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-muted">{k}</dt>
            <dd className="text-right font-mono tabular-nums text-ink">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ContextUsageDetails({
  topicLabel,
  tokens,
  percent,
  contextWindow,
  actionable,
  onStartFresh,
}: {
  topicLabel: string;
  tokens: number;
  percent: number;
  contextWindow: number;
  actionable: boolean;
  onStartFresh: () => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-ui font-medium text-ink-strong">上下文占用</span>
        <span className="font-mono text-ui tabular-nums text-ink">
          {percent.toFixed(1)}%
        </span>
      </div>
      <div className="mt-1.5 text-label leading-relaxed text-ink-muted">
        当前话题「{topicLabel}」的 Claude 会话已用 {formatTokens(tokens)} /{" "}
        {formatTokens(contextWindow)} tokens。占用越高，模型越慢、缓存越难增长。
      </div>
      {actionable ? (
        <>
          <div className="mt-1.5 text-label leading-relaxed text-ink-faint">
            这里暂不支持 claude CLI 的 <code className="rounded bg-surface-muted px-1">/compact</code>。
            可以开一个「新话题」——全新上下文的根问答，等同{" "}
            <code className="rounded bg-surface-muted px-1">/clear</code>。
          </div>
          <Button variant="primary" className="mt-2.5 w-full" onClick={onStartFresh}>
            开新话题（清空上下文）
          </Button>
        </>
      ) : (
        <div className="mt-1.5 text-label leading-relaxed text-ink-faint">
          占用尚低，无需处理。达到 50% 时这里会提供「开新话题」一键清空上下文。
        </div>
      )}
    </div>
  );
}

// 中性细进度条。≥80% 才换 warn 色 —— 那是真正需要注意的时候；其余时间不抢眼。
function ContextMeter({ percent }: { percent: number }) {
  const shown = percent < 10 ? percent.toFixed(1) : String(Math.round(percent));
  return (
    <>
      <span className="text-ink-muted">上下文</span>
      <span
        aria-hidden
        className="relative h-1 w-11 overflow-hidden rounded-full bg-line"
      >
        <span
          className={`absolute inset-y-0 left-0 rounded-full ${
            percent >= 80 ? "bg-warn" : "bg-ink-muted"
          }`}
          style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
        />
      </span>
      <span className={`font-mono tabular-nums ${percent >= 80 ? "text-warn-ink" : "text-ink"}`}>
        {shown}%
      </span>
    </>
  );
}

function basename(p: string): string {
  const stripped = p.replace(/\/+$/, "");
  const idx = stripped.lastIndexOf("/");
  return idx === -1 ? stripped : stripped.slice(idx + 1);
}

export function Header({ isMobile }: { isMobile: boolean }) {
  const isNarrowViewport = useIsNarrowViewport();
  const { isHidden: scrollHidden, reveal: revealScrollChrome } =
    useScrollHideState();
  const session = useSessionStore((s) => s.session);
  const nodes = useSessionStore((s) => s.nodes);
  const activeNodeId = useSessionStore((s) => s.activeNodeId);
  const noteCount = useSessionStore((s) => s.notes.length);
  const bookmarkCount = useSessionStore((s) => s.bookmarksTotal);
  const setNotesOpen = useSessionStore((s) => s.setNotesOpen);
  const setBookmarksOpen = useSessionStore((s) => s.setBookmarksOpen);
  const setSearchOpen = useSessionStore((s) => s.setSearchOpen);
  const setMobileNavOpen = useSessionStore((s) => s.setMobileNavOpen);
  const sidebarOpen = useSessionStore((s) => s.sidebarOpen);
  const setSidebarOpen = useSessionStore((s) => s.setSidebarOpen);
  const chatEnhanced = useSessionStore((s) => s.chatEnhanced);
  const setChatEnhanced = useSessionStore((s) => s.setChatEnhanced);
  const setComposeRootOpen = useSessionStore((s) => s.setComposeRootOpen);
  const setWorkspaceFilesOpen = useSessionStore((s) => s.setWorkspaceFilesOpen);
  const provider = useSessionStore((s) => s.provider);
  const nodeCount = Object.keys(nodes).length;
  const contextWindow = contextWindowFor(provider);
  // 四个桶各自累加。放 useMemo 而不是 Zustand selector：selector 每次返回新对象
  // 会打破引用相等的短路，触发「getSnapshot should be cached」无限渲染。
  const totals = useMemo<Totals>(
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

  // Project 模式下当前话题的上下文占用。Chat 每轮独立，百分比没有意义。
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

  // B3（/compact 降级）：用量浮层恒为可点的按钮形态（「静默从只读变可点」是
  // Session 53 批过的反模式）；<50% 只做只读解释，≥50% 附「开新话题」动作。
  const [ctxPopoverOpen, setCtxPopoverOpen] = useState(false);
  const [mobileOverflowOpen, setMobileOverflowOpen] = useState(false);
  const ctxActionable = ctx != null && ctx.percent >= 50;
  const startFresh = () => {
    setCtxPopoverOpen(false);
    setComposeRootOpen(true);
  };

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
            tooltip={false}
          >
            <Icon icon={Menu} size="lg" />
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
            className="h-11 w-11 p-0"
            tooltip={false}
          >
            <Icon icon={Ellipsis} size="lg" />
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
          <Modal onClose={() => setCtxPopoverOpen(false)} title="上下文占用详情">
            <section
              data-context-usage-dialog
              aria-label="上下文占用详情"
              className="p-4"
            >
              <div className="mb-2 flex justify-end">
                <IconButton
                  label="关闭上下文占用详情"
                  onClick={() => setCtxPopoverOpen(false)}
                  tooltip={false}
                >
                  <Icon icon={X} />
                </IconButton>
              </div>
              <ContextUsageDetails
                topicLabel={ctx.rootLabel}
                tokens={ctx.tokens}
                percent={ctx.percent}
                contextWindow={contextWindow}
                actionable={ctxActionable}
                onStartFresh={startFresh}
              />
              <div className="mt-3 border-t border-line-faint pt-3">
                <UsageStats totals={totals} nodeCount={nodeCount} />
              </div>
            </section>
          </Modal>
        )}
      </>
    );
  }

  const narrowDesktopOverride = isNarrowViewport;
  const workspaceName = session?.workspacePath ? basename(session.workspacePath) : null;
  const sessionTitle = session?.title.trim() || "新会话";

  const exportAs = (format: "markdown" | "json") => {
    if (!session) return;
    const all = Object.values(nodes);
    if (format === "markdown") {
      downloadFile(`${safeFilename(session.title)}.md`, exportMarkdown(session, all), "text/markdown");
    } else {
      downloadFile(
        `${safeFilename(session.title)}.trellis.json`,
        exportJSON(session, all),
        "application/json",
      );
    }
  };

  const usageTip = (
    <span className="tabular-nums">
      输入 {formatTokens(totals.input)} · 输出 {formatTokens(totals.output)} · 缓存读取{" "}
      {formatTokens(totals.cacheRead)}
      {totals.cacheCreation > 0 ? ` · 缓存写入 ${formatTokens(totals.cacheCreation)}` : ""}
    </span>
  );

  return (
    <header
      data-safe-area="header"
      data-header
      className="fixed top-0 inset-x-0 h-12 bg-surface-canvas/85 backdrop-blur border-b border-line flex items-center px-2 sm:px-3 z-40 gap-3"
      style={{
        height: "var(--trellis-header-h)",
        paddingTop: "var(--safe-top)",
      }}
    >
      {/* ── 左：导航 ── */}
      <div data-header-group="nav" className="flex min-w-0 flex-1 items-center gap-1.5">
        {/* 手机以外的窄屏也可能走到这里（md 以下的「转桌面版」）：侧栏不常驻，
            汉堡键打开会话抽屉。 */}
        <IconButton
          label="会话列表"
          data-mobile-target="header-session-drawer"
          onClick={() => setMobileNavOpen(true)}
          className="md:hidden"
        >
          <Icon icon={Menu} />
        </IconButton>
        <IconButton
          label={sidebarOpen ? "收起侧栏" : "展开侧栏"}
          data-header-sidebar-toggle
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="hidden md:inline-flex"
        >
          <Icon icon={sidebarOpen ? PanelLeftClose : PanelLeftOpen} />
        </IconButton>
        {/* 品牌渐变固定色（不随主题换肤，刻意裁决）：#6366f1 → #d946ef → #fbbf24 */}
        <div
          aria-hidden
          className="ml-0.5 size-5 shrink-0 rounded-md bg-gradient-to-br from-[#6366f1] via-[#d946ef] to-[#fbbf24]"
        />
        <span className="hidden shrink-0 text-ui font-semibold tracking-tight text-ink-strong lg:inline">
          Trellis
        </span>
        {session && (
          <nav
            aria-label="当前位置"
            data-header-breadcrumb
            className="ml-1 flex min-w-0 items-center gap-1 text-ui text-ink-muted"
          >
            <Icon icon={ChevronRight} size="sm" className="text-ink-faint" />
            {workspaceName ? (
              <Tooltip content={`${session.workspacePath}（点击浏览工作区文件）`}>
                <button
                  type="button"
                  onClick={() => setWorkspaceFilesOpen(true)}
                  className="max-w-40 shrink truncate rounded-md px-1 hover:bg-surface-hover hover:text-ink"
                >
                  {workspaceName}
                </button>
              </Tooltip>
            ) : (
              <span className="shrink-0 px-1">对话</span>
            )}
            <Icon icon={ChevronRight} size="sm" className="text-ink-faint" />
            <Tooltip content={sessionTitle}>
              <span
                tabIndex={0}
                className="min-w-0 truncate px-1 font-medium text-ink-strong"
              >
                {sessionTitle}
              </span>
            </Tooltip>
          </nav>
        )}
      </div>

      {/* ── 中：会话语境 ── */}
      <div data-header-group="context" className="flex shrink-0 items-center gap-1.5">
        <ModeBadge />
        <ModelPicker />
        {session && (
          <Popover
            open={ctxPopoverOpen}
            onClose={() => setCtxPopoverOpen(false)}
            align="end"
            panelClassName="w-72 p-3"
            trigger={
              <Tooltip content={ctxPopoverOpen ? null : usageTip}>
                <button
                  type="button"
                  data-header-usage
                  onClick={() => setCtxPopoverOpen((v) => !v)}
                  aria-expanded={ctxPopoverOpen}
                  aria-label={
                    ctx
                      ? `上下文占用 ${ctx.percent.toFixed(1)}%，点击查看详情`
                      : "用量，点击查看详情"
                  }
                  className="hidden h-7 items-center gap-2 rounded-field px-2 text-label text-ink-muted transition-colors hover:bg-surface-hover aria-expanded:bg-surface-hover md:inline-flex"
                >
                  {ctx ? (
                    <ContextMeter percent={ctx.percent} />
                  ) : (
                    <span className="tabular-nums">{nodeCount} 个节点</span>
                  )}
                </button>
              </Tooltip>
            }
          >
            {ctx && (
              <div className="mb-3 border-b border-line-faint pb-3">
                <ContextUsageDetails
                  topicLabel={ctx.rootLabel}
                  tokens={ctx.tokens}
                  percent={ctx.percent}
                  contextWindow={contextWindow}
                  actionable={ctxActionable}
                  onStartFresh={startFresh}
                />
              </div>
            )}
            <UsageStats totals={totals} nodeCount={nodeCount} />
          </Popover>
        )}
      </div>

      {/* ── 右：系统 ── */}
      <div data-header-group="system" className="flex flex-1 items-center justify-end gap-1">
        <Tooltip content="搜索会话与节点内容" shortcut="⌘P">
          <button
            type="button"
            aria-label="搜索"
            onClick={() => setSearchOpen(true)}
            className="hidden h-8 w-44 items-center gap-2 rounded-field border border-line bg-surface px-2.5 text-ui text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink-muted lg:inline-flex"
          >
            <Icon icon={Search} size="sm" />
            <span className="flex-1 text-left">搜索</span>
            <Kbd>⌘P</Kbd>
          </button>
        </Tooltip>
        <IconButton
          label="搜索"
          shortcut="⌘P"
          onClick={() => setSearchOpen(true)}
          className="lg:hidden"
        >
          <Icon icon={Search} />
        </IconButton>
        <ThemeMenu />
        <DropdownMenu>
          <Tooltip content="更多">
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="更多"
                data-header-more
                className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-field p-1.5 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink aria-expanded:bg-surface-hover aria-expanded:text-ink"
              >
                <Icon icon={Ellipsis} />
              </button>
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-60">
            {session && (
              <DropdownMenuItem
                icon={<Icon icon={NotebookPen} />}
                shortcut={noteCount > 0 ? noteCount : undefined}
                onSelect={() => setNotesOpen(true)}
              >
                笔记
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              icon={<Icon icon={Bookmark} />}
              shortcut={bookmarkCount > 0 ? bookmarkCount : undefined}
              onSelect={() => setBookmarksOpen(true)}
            >
              稍后再读
            </DropdownMenuItem>
            {session?.workspacePath && (
              <DropdownMenuItem
                icon={<Icon icon={FolderOpen} />}
                onSelect={() => setWorkspaceFilesOpen(true)}
              >
                工作区文件
              </DropdownMenuItem>
            )}
            {session && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  icon={<Icon icon={Download} />}
                  shortcut=".md"
                  onSelect={() => exportAs("markdown")}
                >
                  导出为 Markdown
                </DropdownMenuItem>
                <DropdownMenuItem
                  icon={<Icon icon={Download} />}
                  shortcut=".json"
                  onSelect={() => exportAs("json")}
                >
                  导出为 JSON（可往返）
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            {session?.mode === "chat" && (
              <DropdownMenuItem
                icon={<Icon icon={Sparkles} />}
                shortcut={chatEnhanced ? "开" : "关"}
                title="开启后对话可以跑技能 + 联网（自动批准，无沙箱、能执行任意命令）。默认关 = 纯对话。"
                onSelect={() => setChatEnhanced(!chatEnhanced)}
              >
                增强模式
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              icon={<Icon icon={Keyboard} />}
              shortcut={<Kbd>?</Kbd>}
              onSelect={() => openKeyboardHelp()}
            >
              快捷键
            </DropdownMenuItem>
            {/* 自动化任务：S89 起是管理台的一个 tab，但 Header 上**保留**入口 ——
                「入口太深」是零使用的头号嫌疑（facts.md 第一条）。W4 把它从一个
                独立的 ⏱ 图标收进「更多」，入口仍在一级菜单里。 */}
            <DropdownMenuItem
              icon={<Icon icon={CalendarClock} />}
              onSelect={() => window.location.assign("/settings/tasks")}
            >
              自动化任务
            </DropdownMenuItem>
            {/* 管理员入口：调 GET /__gw/api/me 感知，role=admin 时露出 */}
            {gwMe?.role === "admin" && (
              <DropdownMenuItem
                icon={<Icon icon={ShieldCheck} />}
                onSelect={() => window.location.assign("/admin")}
              >
                管理后台
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {/* 设置是整页而不是弹层：版本、落后的提交、部署进度、失败日志，没有一样
            塞得进下拉。用 <a> 而不是 <Link> —— 从画布跳走时让浏览器真的换一页，
            别把一整棵 React Flow 的状态背着走。 */}
        <Tooltip content="设置">
          <a
            href="/settings"
            aria-label="设置"
            className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-field p-1.5 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
          >
            <Icon icon={Settings} />
          </a>
        </Tooltip>
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
      </div>
    </header>
  );
}
