"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Code,
  FolderGit2,
  History,
  Lightbulb,
  MessageSquare,
  PenLine,
  Plug,
  Scale,
  Sprout,
} from "lucide-react";
import { useSessionStore } from "@/stores/sessionStore";
import { QuestionInput, type QuestionInputHandle } from "@/components/QuestionInput";
import { CliAttachPicker } from "@/components/CliAttachPicker";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Dots,
  Icon,
  Skeleton,
  StatusDot,
  Tooltip,
  cn,
  type StatusTone,
} from "@/components/ui";
import { usePendingActions } from "@/hooks/usePendingActions";
import { useHerdrFleet } from "@/hooks/useHerdrFleet";
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
  // 在线坐席：只逐行列「在干活 / 等你」的，空闲的收成一行计数（常驻坐席动辄十几个，
  // 全列出来会把真正在跑的淹掉）。已经作为「生成中会话」列出的不重复列。
  const { herdrPanes, idlePaneCount } = useMemo(() => {
    const alive = buildHerdrWorkspaceViews(fleet, hooks)
      .flatMap((w) => w.panes)
      .filter((p) => {
        const sid = p.binding?.trellisSessionId ?? p.binding?.sessionId;
        return p.alive && !(sid && runningIds.has(sid));
      });
    const busy = alive.filter((p) => p.status === "working" || p.status === "waiting" || p.status === "blocked");
    return { herdrPanes: busy, idlePaneCount: alive.length - busy.length };
  }, [fleet, hooks, runningIds]);

  const upcoming = useMemo(() => upcomingTasks(tasks ?? [], now), [tasks, now]);
  const problem = useMemo(() => latestProblemRun(tasks ?? []), [tasks]);

  const loaded = data !== null && tasks !== null;
  const isEmpty =
    loaded && data.sessions.length === 0 && tasks.length === 0 && pending.length === 0;

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
          "mx-auto w-full max-w-[880px] px-6 pb-16 max-md:px-4",
          isMobile ? "pt-5" : "pt-12",
        )}
      >
        {/* ── 问候 + 新会话输入 ── */}
        <section aria-labelledby="home-greeting" className="flex flex-col items-center">
          <h1
            id="home-greeting"
            data-home-greeting
            className="text-title font-semibold tracking-tight text-ink-strong max-md:text-reading"
          >
            {greetingFor(now)}
          </h1>
          <p className="mt-1 mb-5 text-center text-ui text-ink-muted max-md:mb-3">
            {isEmpty
              ? "问一个问题开始第一棵树——回答里的任意一段都能选中接着追问。"
              : "从一个新问题开始，或接着处理下面的事。"}
          </p>
          <QuestionInput isMobile={isMobile} variant="home" autoFocus={!isMobile} controlRef={inputRef} />
          <div data-home-quick className="mt-3 flex w-full max-w-2xl flex-wrap justify-center gap-2 max-md:grid max-md:grid-cols-2">
            <Button
              size="sm"
              variant="secondary"
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
                  <Button size="sm" variant="secondary" data-home-quick-item="project">
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
            <Button size="sm" variant="secondary" data-home-quick-item="attach" onClick={() => setAttachOpen(true)}>
              <Icon icon={Plug} size="sm" className="text-ink-faint" />
              接入 CLI 会话
            </Button>
            {recent[0] && (
              <Tooltip content={recent[0].title}>
                <Button size="sm" variant="secondary" data-home-quick-item="last" onClick={() => open(recent[0].id)}>
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
            <Skeleton className="h-36 w-full" />
          </div>
        ) : isEmpty ? (
          <Welcome onPick={(text) => inputRef.current?.fill(text)} />
        ) : (
          <>
            {pending.length > 0 && (
              <HomeSection id="pending" title="等你处理" count={pending.length} tone="warn">
                {pending.map((item) => (
                  <li
                    key={pendingKey(item)}
                    data-home-pending={pendingKey(item)}
                    className="flex min-h-9 items-center gap-2.5 rounded-md px-2 py-1 max-md:flex-wrap max-md:py-2"
                  >
                    <span className="shrink-0 rounded-field border border-warn-line px-1.5 py-0.5 text-nano text-warn-ink">
                      {item.kind === "approval" ? "审批" : "提问"}
                    </span>
                    <span className="max-w-48 shrink-0 truncate text-ui font-medium text-ink" title={item.sessionTitle}>
                      {item.sessionTitle}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-ui text-ink-muted max-md:basis-full" title={item.summary}>
                      {item.summary}
                    </span>
                    <span className="shrink-0 text-label tabular-nums text-ink-faint">
                      {formatRelativeTimeShort(item.createdAt, now.getTime())}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 max-md:ml-auto">
                      <Button size="sm" variant="ghost" onClick={() => void jump(item)}>去处理</Button>
                      {item.kind === "approval" && (
                        <>
                          <Button size="sm" variant="primary" onClick={() => void decide(item, true)}>允许一次</Button>
                          <Button size="sm" variant="secondary" onClick={() => void decide(item, false)}>拒绝</Button>
                        </>
                      )}
                    </span>
                  </li>
                ))}
                {pendingError && <li role="alert" className="px-2 py-1.5 text-ui text-danger-ink">{pendingError}</li>}
              </HomeSection>
            )}

            {(runningSessions.length > 0 || herdrPanes.length > 0) && (
              <HomeSection
                id="running"
                title="正在运行"
                count={runningSessions.length + herdrPanes.length}
                action={idlePaneCount > 0 ? <Meta className="px-2">另有 {idlePaneCount} 个 Herdr 坐席在线空闲</Meta> : undefined}
              >
                {runningSessions.map((s) => (
                  <RowButton key={s.id} data-home-running={s.id} onClick={() => open(s.id)}>
                    <span className="grid w-4 shrink-0 place-items-center"><Dots label="生成中" /></span>
                    <span className="min-w-0 flex-1 truncate text-ui text-ink">{s.title}</span>
                    <Meta className="max-md:hidden">{sessionPlace(s, labels)}</Meta>
                    <Meta className="w-14 text-right">生成中</Meta>
                  </RowButton>
                ))}
                {herdrPanes.map((pane) => {
                  const sid = pane.binding?.trellisSessionId ?? pane.binding?.sessionId;
                  const target = sid && byId.has(sid) ? sid : null;
                  const body = (
                    <>
                      <span className="grid w-4 shrink-0 place-items-center">
                        <StatusDot tone={herdrTone(pane.status)} label={HERDR_STATUS_TEXT[pane.status]} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-ui text-ink">{target ? byId.get(target)!.title : pane.label}</span>
                      <Meta className="max-md:hidden">Herdr · {pane.workspaceLabel}</Meta>
                      <Meta className={cn("w-14 text-right", (pane.status === "waiting" || pane.status === "blocked") && "text-warn-ink")}>
                        {HERDR_STATUS_TEXT[pane.status]}
                      </Meta>
                    </>
                  );
                  return target ? (
                    <RowButton key={pane.paneId} data-home-herdr={pane.paneId} onClick={() => open(target)}>{body}</RowButton>
                  ) : (
                    <li key={pane.paneId} data-home-herdr={pane.paneId} className={ROW_CLASS} title="这个坐席还没有对应的 Trellis 会话">{body}</li>
                  );
                })}
              </HomeSection>
            )}

            {recent.length > 0 && (
              <HomeSection
                id="recent"
                title="最近会话"
                action={
                  <Button size="sm" variant="ghost" data-home-show-all onClick={showAll}>
                    查看全部
                    <Icon icon={ChevronRight} size="sm" />
                  </Button>
                }
              >
                {recent.map((s) => {
                  const status = sessionStatus(s.id, runningIds, waitingSessionIds, unreadIds);
                  return (
                    <RowButton key={s.id} data-home-recent={s.id} onClick={() => open(s.id)}>
                      <span className="grid w-4 shrink-0 place-items-center">
                        {status && <StatusDot tone={status.tone} label={status.label} />}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-ui text-ink">{s.title}</span>
                      <Meta className="max-w-44 truncate max-md:hidden">{sessionPlace(s, labels)}</Meta>
                      {typeof s.nodeCount === "number" && (
                        <Meta className="w-12 text-right tabular-nums">{s.nodeCount} 节</Meta>
                      )}
                      <Meta className="w-12 text-right tabular-nums">{formatRelativeTimeShort(s.updatedAt, now.getTime())}</Meta>
                    </RowButton>
                  );
                })}
              </HomeSection>
            )}

            {(tasks ?? []).length > 0 && (
              <HomeSection
                id="tasks"
                title="自动化任务"
                action={
                  <Button size="sm" variant="ghost" asChild>
                    {/* 设置页整页导航（既定裁决），不走客户端路由 */}
                    <a href="/settings/tasks" data-home-tasks-link>
                      管理任务
                      <Icon icon={ChevronRight} size="sm" />
                    </a>
                  </Button>
                }
              >
                {upcoming.length === 0 && (
                  <li className={cn(ROW_CLASS, "text-ui text-ink-faint")}>
                    <span className="w-4 shrink-0" />
                    暂无排定的运行（任务已停用或只手动运行）
                  </li>
                )}
                {upcoming.map(({ task, at }) => (
                  <li key={task.id} data-home-task={task.id}>
                    <a href="/settings/tasks" className={cn(ROW_CLASS, "hover:bg-surface-hover")}>
                      <span className="grid w-4 shrink-0 place-items-center">
                        <StatusDot tone="idle" label="等待下一次运行" />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-ui text-ink">{task.name}</span>
                      <Meta className="tabular-nums">下次 {formatWhen(at, now)}</Meta>
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
                      className={cn(ROW_CLASS, "hover:bg-surface-hover")}
                    >
                      <span className="grid w-4 shrink-0 place-items-center">
                        {/* interrupted 必须灰（服务重启收尸，不是任务失败）；真失败才红 */}
                        <StatusDot
                          tone={isInterruptedRun(problem.run) ? "neutral" : "danger"}
                          label={runProblemText(problem.run)}
                        />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-ui text-ink">{problem.task.name}</span>
                      <Meta className={isInterruptedRun(problem.run) ? "text-ink-muted" : "text-danger-ink"}>
                        最近一次{runProblemText(problem.run)}
                        {" · "}
                        {formatRelativeTimeShort(problem.run.endedAt ?? problem.run.startedAt ?? problem.run.createdAt, now.getTime())}
                      </Meta>
                    </a>
                  </li>
                )}
              </HomeSection>
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

// 行：高度与侧栏行一致（桌面 28px / 手机 44px 热区），状态只占行首一个槽位。
const ROW_CLASS =
  "flex h-7 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors duration-100 max-md:h-11";

function RowButton({ children, onClick, ...rest }: { children: ReactNode; onClick: () => void } & Record<`data-${string}`, string>) {
  return (
    <li>
      <button type="button" onClick={onClick} className={cn(ROW_CLASS, "hover:bg-surface-hover")} {...rest}>
        {children}
      </button>
    </li>
  );
}

function Meta({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("shrink-0 text-label text-ink-faint", className)}>{children}</span>;
}

function HomeSection({
  id,
  title,
  count,
  tone,
  action,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  tone?: "warn";
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section data-home-section={id} aria-labelledby={`home-${id}`} className="mt-8 max-md:mt-6">
      <div className="mb-1.5 flex min-h-6.5 items-center justify-between px-2">
        <h2 id={`home-${id}`} className="text-label font-medium text-ink-faint">
          {title}
          {typeof count === "number" && <span className="ml-1.5 tabular-nums">{count}</span>}
        </h2>
        {action}
      </div>
      <ul
        className={cn(
          "rounded-card border bg-surface p-1",
          tone === "warn" ? "border-warn-line" : "border-line",
        )}
      >
        {children}
      </ul>
    </section>
  );
}

function Welcome({ onPick }: { onPick: (text: string) => void }) {
  return (
    <section data-home-welcome aria-labelledby="home-welcome" className="mx-auto mt-12 w-full max-w-2xl max-md:mt-8">
      <div className="flex flex-col items-center text-center">
        <div className="mb-3 grid size-9 place-items-center rounded-card border border-line text-ink-faint">
          <Icon icon={Sprout} />
        </div>
        <h2 id="home-welcome" className="text-ui font-medium text-ink">还没有会话</h2>
        <p className="mt-1 max-w-md text-label text-ink-muted">
          可以从下面挑一个起点：点一下只会填进输入框，改好再发。
        </p>
      </div>
      <div className="mt-6 grid gap-2.5 sm:grid-cols-2">
        {STARTERS.map((s) => (
          <button
            key={s.title}
            type="button"
            data-home-starter
            onClick={() => onPick(s.prompt)}
            className="group min-h-[72px] rounded-card border border-line bg-surface px-3.5 py-3 text-left transition-colors hover:border-line-strong hover:bg-surface-hover"
          >
            <span className="flex items-start gap-3">
              <Icon icon={s.icon} className="mt-0.5 shrink-0 text-ink-faint group-hover:text-ink" />
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
  if (waiting.has(id)) return { tone: "warn", label: "等你处理" };
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
