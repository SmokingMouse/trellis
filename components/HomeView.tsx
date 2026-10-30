"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Code,
  Folder,
  FolderGit2,
  History,
  Lightbulb,
  MessageSquare,
  PenLine,
  Plug,
  Scale,
  Sprout,
  Terminal,
} from "lucide-react";
import { useSessionStore } from "@/stores/sessionStore";
import { QuestionInput, type QuestionInputHandle } from "@/components/QuestionInput";
import { CliAttachPicker } from "@/components/CliAttachPicker";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Icon,
  Input,
  PixelLoader,
  Skeleton,
  StatusDot,
  Tooltip,
  cn,
  toast,
  type StatusTone,
} from "@/components/ui";
import { usePendingActions } from "@/hooks/usePendingActions";
import { useHerdrFleet, refreshHerdrFleet } from "@/hooks/useHerdrFleet";
import { openHerdrConsolePane, useHerdrConsole } from "@/hooks/useHerdrConsole";
import { useHerdrConsoleStore } from "@/stores/herdrConsoleStore";
import {
  herdrAttentionKind,
  herdrAttentionText,
  type HerdrConsolePane,
} from "@/lib/herdr-console";
import { sendHerdrInput, sendHerdrKeys } from "@/lib/herdr-actions";
import { buildHerdrWorkspaceViews, type HerdrUiStatus } from "@/lib/herdr-ui";
import { pendingKey } from "@/lib/pending";
import { formatRelativeTimeShort } from "@/lib/relative-time";
import {
  formatWhen,
  greetingFor,
  isInterruptedRun,
  latestProblemRun,
  recentWorkspaces,
  runProblemText,
  sessionPlace,
  upcomingTasks,
  workspaceLabels,
  type HomeTask,
} from "@/lib/home";
import type { ProjectSummary, Session } from "@/lib/types";

// 首页（工作台总览）。主 SPA 内的一个视图：session 为空且 homeOpen 时由 app/page.tsx 渲染。
//
// 数据全部复用现有来源，不新建轮询：
//   最近会话 / 工作区 —— GET /api/sessions（与侧栏同一端点，随 sessionsRevision 重拉）
//   等你处理        —— store.pending（useRunPolling 喂的 /api/runs 快照，PendingBar 同源）
//   正在运行        —— store.runningSessionIds（同上）+ useHerdrFleet（侧栏已订阅的模块级快照）
//   自动化任务      —— GET /api/tasks（任务页同一端点，挂载时拉一次、窗口回焦再拉）
//
// 借 happyclaw 的结构（问候 + 输入 + 快捷入口；空库时 2×2 起点卡），不借它的毛玻璃 / 渐变 / emoji。

const RECENT_LIMIT = 10;

const STARTERS: { icon: typeof Lightbulb; title: string; prompt: string }[] = [
  { icon: Lightbulb, title: "把一个概念讲透", prompt: "用类比讲清楚 TCP 和 UDP 的区别，再举一个我日常能碰到的例子。" },
  { icon: Code, title: "读懂一段代码", prompt: "帮我看看下面这段代码，指出潜在的 bug 和可以写得更简单的地方：\n\n" },
  { icon: Scale, title: "理清一个决定", prompt: "我在纠结要不要……帮我列出关键的取舍，以及还缺哪些信息才能下决定。" },
  { icon: PenLine, title: "改一段文字", prompt: "把下面这段话改得更清楚、更专业，意思不要变：\n\n" },
];

const HERDR_STATUS_TEXT: Record<HerdrUiStatus, string> = {
  working: "工作中",
  waiting: "等你回复",
  blocked: "等你批准",
  idle: "空闲",
  done: "已完成",
  unknown: "状态未知",
};

type SessionsPayload = { sessions: Session[]; projects: ProjectSummary[] };

export function HomeView({ isMobile }: { isMobile: boolean }) {
  const inputRef = useRef<QuestionInputHandle>(null);
  // 「新会话」落首页时把光标送进输入框；手机不抢焦点（避免弹键盘）。
  const homeFocusNonce = useSessionStore((s) => s.homeFocusNonce);
  useEffect(() => {
    if (homeFocusNonce > 0 && !isMobile) inputRef.current?.focus();
  }, [homeFocusNonce, isMobile]);
  const sessionsRevision = useSessionStore((s) => s.sessionsRevision);
  const bumpSessionsRevision = useSessionStore((s) => s.bumpSessionsRevision);
  const previewSession = useSessionStore((s) => s.previewSession);
  const setDraftMode = useSessionStore((s) => s.setDraftMode);
  const setDraftWorkspacePath = useSessionStore((s) => s.setDraftWorkspacePath);
  const setSidebarOpen = useSessionStore((s) => s.setSidebarOpen);
  const setMobileNavOpen = useSessionStore((s) => s.setMobileNavOpen);
  const runningIds = useSessionStore((s) => s.runningSessionIds);
  const unreadIds = useSessionStore((s) => s.unreadSessionIds);
  const { items: pending, error: pendingError, jump, decide } = usePendingActions();
  const { fleet, hooks } = useHerdrFleet();

  const [data, setData] = useState<SessionsPayload | null>(null);
  const [tasks, setTasks] = useState<HomeTask[] | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  // 问候与「下一次运行」按分钟刷新就够了；首帧在客户端算（本组件只在 hydrate 后挂载）。
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.pending) useSessionStore.getState().ingestPending(d.pending);
        setData({ sessions: d.sessions ?? [], projects: d.projects ?? [] });
      })
      .catch(() => {
        if (!cancelled) setData((prev) => prev ?? { sessions: [], projects: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionsRevision]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/tasks")
        .then((r) => r.json())
        .then((d) => {
          if (!cancelled) setTasks(d.tasks ?? []);
        })
        .catch(() => {
          if (!cancelled) setTasks((prev) => prev ?? []);
        });
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const labels = useMemo(() => workspaceLabels(data?.projects ?? []), [data]);
  const byId = useMemo(() => new Map((data?.sessions ?? []).map((s) => [s.id, s])), [data]);
  const recent = useMemo(
    () => (data?.sessions ?? []).filter((s) => s.kind !== "task").slice(0, RECENT_LIMIT),
    [data],
  );
  const workspaces = useMemo(() => recentWorkspaces(data?.projects ?? [], labels), [data, labels]);
  const waitingSessionIds = useMemo(() => new Set(pending.map((p) => p.sessionId)), [pending]);

  const runningSessions = useMemo(
    () => [...runningIds].map((id) => byId.get(id)).filter((s): s is Session => Boolean(s)),
    [runningIds, byId],
  );

  const hc = useHerdrConsole();
  const waitingHerdrPanes = useMemo(() => {
    if (!hc.available) return [];
    return hc.panes.filter((p) => p.lane === "need");
  }, [hc.available, hc.panes]);

  const runningHerdrPanes = useMemo(() => {
    if (!hc.available) return [];
    return hc.panes.filter((p) => p.lane === "run" && !(p.sessionId && runningIds.has(p.sessionId)));
  }, [hc.available, hc.panes, runningIds]);

  const idlePaneCount = useMemo(() => {
    if (!hc.available) return 0;
    return hc.panes.filter((p) => p.lane === "idle").length;
  }, [hc.available, hc.panes]);

  const upcoming = useMemo(() => upcomingTasks(tasks ?? [], now), [tasks, now]);
  const problem = useMemo(() => latestProblemRun(tasks ?? []), [tasks]);

  const totalPending = pending.length + waitingHerdrPanes.length;
  const totalRunning = runningSessions.length + runningHerdrPanes.length;

  const loaded = data !== null && tasks !== null;
  const isEmpty =
    loaded && data.sessions.length === 0 && tasks.length === 0 && totalPending === 0;

  const open = (id: string) => void previewSession(id);
  const showAll = () => {
    if (isMobile) {
      setMobileNavOpen(true);
      return;
    }
    setSidebarOpen(true);
    // 侧栏是常驻栏：展开后把焦点送到列表里第一行，键盘用户可以直接往下走。
    window.requestAnimationFrame(() => {
      const first = document.querySelector<HTMLElement>(
        "[data-sidebar] [data-sidebar-list] [data-sidebar-session-item] [role='button'], [data-sidebar] [data-sidebar-list] [data-sidebar-session-item] button",
      );
      first?.focus();
      first?.scrollIntoView({ block: "nearest" });
    });
  };

  const bothCards = totalPending > 0 && totalRunning > 0;

  return (
    <main
      data-home
      // body / html 是 overflow:hidden（工作台各视图各管各的滚动），首页自己当滚动容器：
      // 桌面落在侧栏右侧、tab 条下方；手机落在 Header 下方。
      className="fixed inset-x-0 bottom-0 overflow-y-auto overscroll-contain"
      style={
        isMobile
          ? { top: "var(--trellis-header-h)", paddingBottom: "var(--safe-bottom)" }
          : { top: "calc(3rem + 2.25rem)", left: "var(--trellis-sb, 0px)" }
      }
    >
      <div
        className={cn(
          "mx-auto w-full max-w-[760px] px-6 pb-24 max-md:px-4 max-md:pb-10",
          // 桌面：原型 .home padding-top 72px 是从顶栏下沿量的；这里的滚动容器已从会话 tab 条（36px）下沿起，
          // 所以只补 36px，问候落在顶栏下 ~72px。
          isMobile ? "pt-5" : "pt-9",
        )}
      >
        {/* ── 问候 + 新会话输入（原型 .greet / .greet-sub / .starts） ── */}
        <section aria-labelledby="home-greeting" className="flex flex-col">
          <h1
            id="home-greeting"
            data-home-greeting
            className="ui-enter-up text-[26px] leading-tight md:leading-[1.5] font-semibold tracking-[-0.02em] text-ink-strong max-md:text-title"
          >
            {greetingFor(now)}
          </h1>
          <p
            className="ui-enter-up mt-1.5 mb-6 text-body text-ink-muted max-md:mb-3 max-md:text-ui"
            style={{ animationDelay: "40ms" }}
          >
            {isEmpty
              ? "问一个问题开始第一棵树——回答里的任意一段都能选中接着追问。"
              : "从一个新问题开始，或接着处理下面的事。"}
          </p>
          <div className="ui-enter-up" style={{ animationDelay: "80ms" }}>
            <QuestionInput isMobile={isMobile} variant="home" autoFocus={!isMobile} controlRef={inputRef} />
          </div>
          <div
            data-home-quick
            className="ui-enter-up mt-3 flex w-full flex-wrap gap-1.5 max-md:grid max-md:grid-cols-2"
            style={{ animationDelay: "120ms" }}
          >
            <Button
              size="sm"
              variant="secondary"
              className={START_BTN}
              data-home-quick-item="chat"
              onClick={() => {
                setDraftMode("chat");
                inputRef.current?.focus();
              }}
            >
              <Icon icon={MessageSquare} size="sm" className="text-ink-faint" />
              新 Chat
            </Button>
            {workspaces.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="secondary" className={START_BTN} data-home-quick-item="project">
                    <Icon icon={FolderGit2} size="sm" className="text-ink-faint" />
                    在工作区开 Project
                    <Icon icon={ChevronDown} size="sm" className="text-ink-faint" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-w-80">
                  <DropdownMenuLabel>最近用过的工作区</DropdownMenuLabel>
                  {workspaces.map((w) => (
                    <DropdownMenuItem
                      key={w.id}
                      icon={<Icon icon={FolderGit2} size="sm" />}
                      onSelect={() => {
                        setDraftMode("project");
                        setDraftWorkspacePath(w.path);
                        inputRef.current?.focus();
                      }}
                    >
                      <span className="min-w-0 truncate" title={w.path}>{w.label}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button
              size="sm"
              variant="secondary"
              className={START_BTN}
              data-home-quick-item="attach"
              onClick={() => setAttachOpen(true)}
            >
              <Icon icon={Plug} size="sm" className="text-ink-faint" />
              接入 CLI 会话
            </Button>
            {recent[0] && (
              <Tooltip content={recent[0].title}>
                <Button
                  size="sm"
                  variant="secondary"
                  className={START_BTN}
                  data-home-quick-item="last"
                  onClick={() => open(recent[0].id)}
                >
                  <Icon icon={History} size="sm" className="text-ink-faint" />
                  打开最近会话
                </Button>
              </Tooltip>
            )}
          </div>
        </section>

        {!loaded ? (
          <div className="mt-10 space-y-2" aria-hidden>
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-36 w-full rounded-card" />
          </div>
        ) : isEmpty ? (
          <Welcome onPick={(text) => inputRef.current?.fill(text)} />
        ) : (
          <>
            {(totalPending > 0 || totalRunning > 0) && (
              // 原型 .cards2：两张都有时桌面并排，否则单张占满
              <div className={cn("mt-7 grid items-start gap-3 max-md:mt-6", bothCards && "lg:grid-cols-2")}>
                {totalPending > 0 && (
                  <HomeCard
                    id="pending"
                    title="等你处理"
                    count={totalPending}
                    lead={<StatusDot tone="attention" />}
                    delay={160}
                  >
                    {pending.map((item) => (
                      <li
                        key={pendingKey(item)}
                        data-home-pending={pendingKey(item)}
                        className={cn(TROW, "group flex-wrap gap-y-2 md:flex-nowrap md:focus-within:bg-surface-hover")}
                      >
                        <Badge variant={item.kind === "approval" ? "accent" : "warn"} dot={false}>
                          {item.kind === "approval" ? "审批" : "提问"}
                        </Badge>
                        <span className="min-w-0 flex-1">
                          <span className={ROW_TITLE} title={item.summary}>{item.summary}</span>
                          <span className={ROW_SUB} title={item.sessionTitle}>
                            {item.sessionTitle}
                            <span className="tabular-nums"> · {formatRelativeTimeShort(item.createdAt, now.getTime())}</span>
                          </span>
                        </span>
                        <span className="ml-auto flex shrink-0 items-center gap-1.5 md:relative">
                          {/* 桌面原型 .trow 行尾只留一个常显主操作：审批行是「允许一次」（9/28 裁决：允许一次为主按钮，
                              不能藏进 hover），提问行是「去处理」；其余（拒绝 / 去处理）收进行 hover / focus-within。手机照旧全显。 */}
                          {item.kind === "approval" ? (
                            <>
                              <span className={ROW_SECONDARY}>
                                <Button size="sm" variant="secondary" onClick={() => void decide(item, false)}>拒绝</Button>
                                <Button size="sm" variant="ghost" onClick={() => void jump(item)}>去处理</Button>
                              </span>
                              <Button size="sm" variant="primary" onClick={() => void decide(item, true)}>允许一次</Button>
                            </>
                          ) : (
                            <Button size="sm" variant="secondary" onClick={() => void jump(item)}>
                              去处理
                            </Button>
                          )}
                        </span>
                      </li>
                    ))}
                    {waitingHerdrPanes.map((pane) => (
                      <HomeHerdrPendingItem key={pane.key} pane={pane} now={now.getTime()} />
                    ))}
                    {pendingError && <li role="alert" className="px-3 py-2.5 text-ui text-danger-ink">{pendingError}</li>}
                  </HomeCard>
                )}

                {totalRunning > 0 && (
                  <HomeCard
                    id="running"
                    title="正在运行"
                    count={totalRunning}
                    lead={<PixelLoader size="sm" label={null} />}
                    delay={bothCards ? 200 : 160}
                    action={
                      idlePaneCount > 0 ? (
                        <span className="truncate text-label text-ink-faint">另有 {idlePaneCount} 个 Herdr 坐席在线空闲</span>
                      ) : undefined
                    }
                  >
                    {runningSessions.map((s) => (
                      <RowButton key={s.id} data-home-running={s.id} onClick={() => open(s.id)}>
                        <span className="grid w-4 shrink-0 place-items-center">
                          <PixelLoader size="sm" round label="生成中" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={ROW_TITLE}>{s.title}</span>
                          <span className={ROW_SUB}>{sessionPlace(s, labels)}</span>
                        </span>
                        <span className="shrink-0 text-[11.5px] text-ink-faint">生成中</span>
                      </RowButton>
                    ))}
                    {runningHerdrPanes.map((pane) => {
                      const target = pane.sessionId && byId.has(pane.sessionId) ? pane.sessionId : null;
                      return (
                        <RowButton key={pane.key} data-home-herdr={pane.paneId} onClick={() => openHerdrConsolePane(pane)}>
                          <span className="grid w-4 shrink-0 place-items-center">
                            <PixelLoader size="sm" round label="工作中" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className={ROW_TITLE}>{target ? byId.get(target)!.title : pane.title}</span>
                            <span className={ROW_SUB}>Herdr · {pane.workspaceLabel} · {pane.tabLabel}</span>
                          </span>
                          <span className="shrink-0 text-[11.5px] text-ink-faint">工作中</span>
                        </RowButton>
                      );
                    })}
                  </HomeCard>
                )}
              </div>
            )}

            {recent.length > 0 && (
              <section
                data-home-section="recent"
                aria-labelledby="home-recent"
                className="ui-enter-up mt-7 max-md:mt-6"
                style={{ animationDelay: "240ms" }}
              >
                <div className="mb-1.5 flex min-h-6.5 items-center justify-between">
                  <h2 id="home-recent" className="text-[12.5px] font-medium text-ink-faint">最近会话</h2>
                  <Button size="sm" variant="ghost" className="-mr-2.5 text-ink-faint" data-home-show-all onClick={showAll}>
                    查看全部
                    <Icon icon={ChevronRight} size="sm" />
                  </Button>
                </div>
                <ul className="-mx-2.5">
                  {recent.map((s) => {
                    const status = sessionStatus(s.id, runningIds, waitingSessionIds, unreadIds);
                    return (
                      <li key={s.id}>
                        <button
                          type="button"
                          data-home-recent={s.id}
                          onClick={() => open(s.id)}
                          className="flex h-[38px] w-full items-center gap-2.5 rounded-field px-2.5 text-left transition-colors duration-100 hover:bg-surface-hover max-md:h-11"
                        >
                          <span className="grid w-4 shrink-0 place-items-center">
                            {status?.tone === "live" ? (
                              <PixelLoader size="sm" round label={status.label} />
                            ) : status ? (
                              <StatusDot tone={status.tone} label={status.label} />
                            ) : (
                              <Icon icon={s.mode === "project" ? FolderGit2 : MessageSquare} size="sm" className="text-ink-faint" />
                            )}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{s.title}</span>
                          <span className="inline-flex h-5 max-w-44 shrink-0 items-center gap-1 rounded-chip bg-surface-muted px-1.5 text-[11px] text-ink-muted shadow-hairline max-md:hidden">
                            <Icon icon={Folder} size="sm" className="size-3 shrink-0 text-ink-faint" />
                            <span className="truncate">{sessionPlace(s, labels)}</span>
                          </span>
                          <span className="shrink-0 text-label tabular-nums text-ink-faint">
                            {typeof s.nodeCount === "number" && <>{s.nodeCount} 节 · </>}
                            {formatRelativeTimeShort(s.updatedAt, now.getTime())}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {(tasks ?? []).length > 0 && (
              <HomeCard
                id="tasks"
                title="自动化任务"
                delay={280}
                className="mt-7 max-md:mt-6"
                action={
                  <Button size="sm" variant="ghost" className="-mr-1.5 text-ink-faint" asChild>
                    {/* 设置页整页导航（既定裁决），不走客户端路由 */}
                    <a href="/settings/tasks" data-home-tasks-link>
                      管理任务
                      <Icon icon={ChevronRight} size="sm" />
                    </a>
                  </Button>
                }
              >
                {upcoming.length === 0 && (
                  <li className={cn(TROW, "text-ui text-ink-faint hover:bg-transparent")}>
                    <span className="w-4 shrink-0" />
                    暂无排定的运行（任务已停用或只手动运行）
                  </li>
                )}
                {upcoming.map(({ task, at }) => (
                  <li key={task.id} data-home-task={task.id}>
                    <a href="/settings/tasks" className={TROW}>
                      <span className="grid w-4 shrink-0 place-items-center">
                        <StatusDot tone="idle" label="等待下一次运行" />
                      </span>
                      <span className={cn(ROW_TITLE, "min-w-0 flex-1")}>{task.name}</span>
                      <span className="shrink-0 text-label tabular-nums text-ink-faint">下次 {formatWhen(at, now)}</span>
                    </a>
                  </li>
                ))}
                {problem && (
                  <li data-home-task-problem={problem.run.id} data-interrupted={isInterruptedRun(problem.run) ? "" : undefined}>
                    <a
                      href={
                        problem.run.sessionId
                          ? `/?session=${encodeURIComponent(problem.run.sessionId)}${problem.run.nodeId ? `&node=${encodeURIComponent(problem.run.nodeId)}` : ""}`
                          : "/settings/tasks"
                      }
                      className={TROW}
                    >
                      <span className="grid w-4 shrink-0 place-items-center">
                        {/* interrupted 必须灰（服务重启收尸，不是任务失败）；真失败才红 */}
                        <StatusDot
                          tone={isInterruptedRun(problem.run) ? "neutral" : "danger"}
                          label={runProblemText(problem.run)}
                        />
                      </span>
                      <span className={cn(ROW_TITLE, "min-w-0 flex-1")}>{problem.task.name}</span>
                      <span
                        className={cn(
                          "shrink-0 text-label tabular-nums",
                          isInterruptedRun(problem.run) ? "text-ink-muted" : "text-danger-ink",
                        )}
                      >
                        最近一次{runProblemText(problem.run)}
                        {" · "}
                        {formatRelativeTimeShort(problem.run.endedAt ?? problem.run.startedAt ?? problem.run.createdAt, now.getTime())}
                      </span>
                    </a>
                  </li>
                )}
              </HomeCard>
            )}
          </>
        )}
      </div>
      {attachOpen && (
        <CliAttachPicker onClose={() => setAttachOpen(false)} onChanged={bumpSessionsRevision} />
      )}
    </main>
  );
}

// 原型 .starts：胶囊次级按钮，字色降一档，图标再降一档（手机 44px 热区由 Button 兜底）
const START_BTN = "min-h-7 rounded-full px-3 text-[12.5px] text-ink-muted hover:text-ink";

// 原型 .trow：卡内分隔行（分隔线由 HomeCard 的 divide-y 画），两行文字 + 行尾动作
const TROW =
  "flex w-full items-center gap-2.5 px-3 py-2.5 md:py-[11px] text-left transition-colors duration-100 hover:bg-surface-hover max-md:min-h-11";
const ROW_TITLE = "block truncate text-ui font-medium text-ink";
const ROW_SUB = "block truncate text-[11.5px] leading-snug text-ink-faint";
// 行内次要动作：手机 contents（照旧和主动作并排），桌面平时收起、行 hover / 键盘焦点进行内时才出现——
// Tab 先落到行内标题按钮，focus-within 展开后下一跳就能进到这些按钮，键盘可达。
// 桌面展开时浮在主动作左侧（盖住标题末尾、底色同行 hover 色），不挤压标题、不引起重排。
const ROW_SECONDARY =
  "contents md:absolute md:inset-y-0 md:right-full md:hidden md:items-center md:gap-1.5 md:bg-surface-hover md:pr-1.5 md:pl-3 md:group-hover:flex md:group-focus-within:flex";

function RowButton({ children, onClick, ...rest }: { children: ReactNode; onClick: () => void } & Record<`data-${string}`, string>) {
  return (
    <li>
      <button type="button" onClick={onClick} className={TROW} {...rest}>
        {children}
      </button>
    </li>
  );
}

// 原型 .card + .card-hd：小号卡头（状态点 / loader · 标题 · 计数 · 右侧链接），下面是分隔行。
function HomeCard({
  id,
  title,
  count,
  lead,
  action,
  delay = 0,
  className,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  lead?: ReactNode;
  action?: ReactNode;
  delay?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      data-home-section={id}
      aria-labelledby={`home-${id}`}
      className={cn("ui-enter-up min-w-0 overflow-hidden rounded-card bg-surface-raised shadow-raise", className)}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex min-h-9 items-center gap-2 px-3 pt-2 pb-1.5">
        {lead && <span className="grid w-4 shrink-0 place-items-center">{lead}</span>}
        <h2 id={`home-${id}`} className="shrink-0 text-[12.5px] font-medium text-ink-muted">
          {title}
          {typeof count === "number" && <span className="ml-1.5 tabular-nums text-ink-faint">{count}</span>}
        </h2>
        <span className="min-w-0 flex-1" />
        {action}
      </div>
      <ul className="divide-y divide-line border-t border-line">{children}</ul>
    </section>
  );
}

function Welcome({ onPick }: { onPick: (text: string) => void }) {
  return (
    <section data-home-welcome aria-labelledby="home-welcome" className="mt-12 w-full max-md:mt-8">
      <div className="ui-enter-up flex flex-col items-center text-center" style={{ animationDelay: "160ms" }}>
        <div className="mb-3 grid size-9 place-items-center rounded-card bg-surface-raised text-ink-faint shadow-raise">
          <Icon icon={Sprout} />
        </div>
        <h2 id="home-welcome" className="text-ui font-medium text-ink">还没有会话</h2>
        <p className="mt-1 max-w-md text-label text-ink-muted">
          可以从下面挑一个起点：点一下只会填进输入框，改好再发。
        </p>
      </div>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {STARTERS.map((s, i) => (
          <button
            key={s.title}
            type="button"
            data-home-starter
            onClick={() => onPick(s.prompt)}
            className="ui-enter-up group min-h-[72px] rounded-card bg-surface-raised px-3.5 py-3 text-left shadow-raise transition-colors duration-100 hover:bg-surface-hover"
            style={{ animationDelay: `${200 + i * 50}ms` }}
          >
            <span className="flex items-start gap-3">
              <Icon icon={s.icon} className="mt-0.5 shrink-0 text-ink-faint transition-colors group-hover:text-ink" />
              <span className="min-w-0">
                <span className="block truncate text-ui font-medium text-ink">{s.title}</span>
                <span className="mt-0.5 line-clamp-2 block text-label text-ink-muted">{s.prompt.trim()}</span>
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function sessionStatus(
  id: string,
  running: Set<string>,
  waiting: Set<string>,
  unread: Set<string>,
): { tone: StatusTone; label: string } | null {
  if (waiting.has(id)) return { tone: "attention", label: "等你处理" };
  if (running.has(id)) return { tone: "live", label: "生成中" };
  if (unread.has(id)) return { tone: "unread", label: "完成·未读" };
  return null;
}

function herdrTone(status: HerdrUiStatus): StatusTone {
  if (status === "working") return "live";
  if (status === "waiting" || status === "blocked") return "warn";
  if (status === "done") return "positive";
  return "neutral";
}

function HomeHerdrPendingItem({ pane, now }: { pane: HerdrConsolePane; now: number }) {
  const kind = herdrAttentionKind(pane);
  const text = herdrAttentionText(pane);
  const [replying, setReplying] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (replying) inputRef.current?.focus();
  }, [replying]);

  const send = async () => {
    const val = replyText.trim();
    if (!val || sending) return;
    setSending(true);
    try {
      await sendHerdrKeys(pane.paneId, ["Escape"]);
      const result = await sendHerdrInput(pane.paneId, val);
      toast.success(result.status === "queued" ? `已排队，空闲后发送至 ${pane.workspaceLabel}` : `已发送至 ${pane.workspaceLabel}`);
      setReplyText("");
      setReplying(false);
      void refreshHerdrFleet();
    } catch (err) {
      toast.error("发送失败", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setSending(false);
    }
  };

  const handleOpenTerminal = () => {
    useHerdrConsoleStore.getState().openDrawer(pane.paneId);
  };


  return (
    <li data-home-herdr-pending={pane.paneId} className="group flex flex-col transition-colors duration-100 hover:bg-surface-hover md:focus-within:bg-surface-hover">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 px-3 py-2.5 md:flex-nowrap md:py-[11px]">
        <Badge variant={kind === "approval" ? "accent" : "warn"} dot={false}>
          {kind === "approval" ? "审批" : "提问"}
        </Badge>
        <button
          type="button"
          onClick={() => openHerdrConsolePane(pane)}
          className="min-w-0 flex-1 text-left max-md:min-h-11"
          title={`${pane.title} (${pane.workspaceLabel} · ${pane.tabLabel})`}
        >
          <span className={ROW_TITLE} title={text}>{text}</span>
          <span className={cn(ROW_SUB, "font-mono")}>
            {pane.title}
            {pane.activityAt && (
              <span className="font-sans tabular-nums text-warn-ink"> · {formatRelativeTimeShort(pane.activityAt, now)}</span>
            )}
          </span>
        </button>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 md:relative">
          {/* 回复 / 终端：桌面收进 hover / focus-within（行内回复展开时常显，好收起） */}
          <span className={replying ? "contents" : ROW_SECONDARY}>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setReplying((v) => !v)}
            title="行内回复"
          >
            {replying ? "收起" : "回复"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleOpenTerminal}
            title="在终端抽屉中打开"
          >
            <Icon icon={Terminal} size="sm" className="text-ink-faint" />
            终端
          </Button>
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => openHerdrConsolePane(pane)}
          >
            {pane.sessionId ? "去处理" : "直达"}
          </Button>
        </span>
      </div>
      {replying && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="ui-enter-up flex items-center gap-2 px-3 pb-2.5"
        >
          <Input
            ref={inputRef}
            size="sm"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder={`回复 ${pane.workspaceLabel} · ${pane.tabLabel}，回车直接发送...`}
            className="flex-1 max-md:min-h-11"
            disabled={sending}
          />
          <Button size="sm" variant="primary" type="submit" disabled={!replyText.trim() || sending}>
            {sending ? "发送中..." : "发送"}
          </Button>
        </form>
      )}
    </li>
  );
}
