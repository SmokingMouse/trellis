"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import {
  Anchor,
  Archive,
  ArchiveRestore,
  Bookmark,
  CalendarClock,
  Check,
  ChevronRight,
  CircleHelp,
  Ellipsis,
  FileDiff,
  FolderGit2,
  GitBranch,
  House,
  Inbox,
  MessageSquare,
  PanelLeftClose,
  Pencil,
  Pin,
  PinOff,
  Plug,
  Plus,
  Trash2,
  BrushCleaning,
  type LucideIcon,
} from "lucide-react";
import { CliAttachPicker } from "@/components/CliAttachPicker";
import {
  Button,
  Checkbox,
  Dots,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  Input,
  SegmentedControl,
  Select,
  StatusDot,
  toast,
  useConfirm,
} from "@/components/ui";
import {
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  loadSidebarWidth,
  persistSidebarWidth,
} from "@/lib/workbench-layout";
import { useIsDesktopViewport } from "@/hooks/useIsMobile";
import { formatRelativeTimeShort } from "@/lib/relative-time";
import { ContextMenu, useContextMenuWithTarget, type ContextMenuItem } from "@/components/ui/ContextMenu";
import {
  STATUS_PRIORITY,
  deriveRecentChainStatus,
  resolveSessionCollapsed,
  resolveTreeExpanded,
  toggleSessionCollapsedState,
  toggleTreeExpandedState,
  type RecentChainStatus,
  type SessionTree,
  type SessionTreeChain,
} from "@/lib/recent";
import {
  HOME_CLUSTER_KEY,
  SCRATCH_CLUSTER_KEY,
  type ProjectSummary,
  type RecentChain,
  type WorkspaceSummary,
  type Session,
  type WorkspaceGitStatus,
} from "@/lib/types";
import { WorkspaceDiffModal } from "@/components/WorkspaceDiffModal";
import { BatchCleanModal } from "@/components/BatchCleanModal";
import { sessionSourceChip } from "@/lib/session-source";
import { useHerdrSessionStatuses } from "@/hooks/useHerdrFleet";
import { type HerdrSessionStatus } from "@/lib/herdr-ui";
import { isBoolean, isStringArray, useSidebarPreference } from "@/hooks/useSidebarPreference";
import { herdrOffline, selectSidebarSessions, sessionLocation, sidebarSource, projectPresentation, partitionEmptyWorkspaces, type SidebarLayout, type SidebarSource } from "@/lib/sidebar-view";

const isLayout = (v: unknown): v is SidebarLayout => v === "project" || v === "time";
const isSource = (v: unknown): v is SidebarSource => ["all", "web", "herdr", "task", "lark", "external"].includes(v as string);

// 左侧会话侧栏（方案 A：一棵树 + 一条工具条，见 progress/sidebar-tree-ia.md）。
//
//  - 桌面常驻（md 以上），宽度可拖拽，收起后由 Header 左上角的侧栏开关展开；
//    手机端是 Header 汉堡键打开的抽屉，两处共用 renderPanel。
//  - 工具条：「按项目 / 按时间」SegmentedControl + 来源 Select + 含已归档 Checkbox。
//  - 行：单击预览（斜体、不占标签位），双击固定；右键 / 行尾「更多」出同一套菜单。
//    状态只用行首一个槽位（生成中 Dots / 等你回答 / 出错点 / 未读点），行尾是
//    中性小字 meta；hover 时 meta 让位给「更多」按钮，但**占位不变**，行内容不闪。
//
// W4 删除了方案 A 落地前的 legacy 路径（NEXT_PUBLIC_TRELLIS_SIDEBAR_V2=off 时的
// 「最近」分组、独立 Herdr 分组、底部已归档折叠区）。

export function SessionSidebar() {
  const [layout, setLayout] = useSidebarPreference("layout", "project" as SidebarLayout, isLayout);
  const [source, setSource] = useSidebarPreference("source", "all" as SidebarSource, isSource);
  const [includeArchived, setIncludeArchived] = useSidebarPreference("include-archived", false, isBoolean);
  const { statuses: herdrStatus, available: herdrAvailable, unavailableText } = useHerdrSessionStatuses();
  const fleetSessionKey = [...herdrStatus.keys()].sort().join(",");
  const activeId = useSessionStore((s) => s.session?.id ?? null);
  const previewId = useSessionStore((s) => s.previewSessionId);
  const previewSession = useSessionStore((s) => s.previewSession);
  const pinSession = useSessionStore((s) => s.pinSession);
  const unpinSession = useSessionStore((s) => s.unpinSession);
  const pinnedIds = useSessionStore((s) => s.pinnedSessionIds);
  const newConversation = useSessionStore((s) => s.newConversation);
  const renameSession = useSessionStore((s) => s.renameSession);
  const archiveSession = useSessionStore((s) => s.archiveSession);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const sidebarOpen = useSessionStore((s) => s.sidebarOpen);
  const setSidebarOpen = useSessionStore((s) => s.setSidebarOpen);
  const mobileNavOpen = useSessionStore((s) => s.mobileNavOpen);
  const setMobileNavOpen = useSessionStore((s) => s.setMobileNavOpen);
  const sessionsRevision = useSessionStore((s) => s.sessionsRevision);
  const runningIds = useSessionStore((s) => s.runningSessionIds);
  const runningNodeIds = useSessionStore((s) => s.runningNodeIds);
  const waitingNodeIds = useSessionStore((s) => s.waitingNodeIds);
  const unreadIds = useSessionStore((s) => s.unreadSessionIds);
  const unarchiveSession = useSessionStore((s) => s.unarchiveSession);
  const bumpSessionsRevision = useSessionStore((s) => s.bumpSessionsRevision);
  const liveSessionIds = useSessionStore((s) => s.liveSessionIds);
  const setDraftMode = useSessionStore((s) => s.setDraftMode);
  const setDraftWorkspacePath = useSessionStore((s) => s.setDraftWorkspacePath);
  const openNodeInSession = useSessionStore((s) => s.openNodeInSession);
  const setViewMode = useSessionStore((s) => s.setViewMode);
  const activeNodeId = useSessionStore((s) => s.activeNodeId);
  const [attachOpen, setAttachOpen] = useState(false);
  const [mobileAdvancedOpen, setMobileAdvancedOpen] = useState(false);
  const [diffTarget, setDiffTarget] = useState<{
    id: string;
    name?: string;
    path?: string;
  } | null>(null);
  const [batchCleanTarget, setBatchCleanTarget] = useState<{
    ids: string[];
    projectName?: string;
  } | null>(null);
  // 新建 worktree 的行内表单：值 = 正在建的 projectId，null = 没在建
  const [wtFor, setWtFor] = useState<string | null>(null);
  const [wtBranch, setWtBranch] = useState("");
  const [wtBusy, setWtBusy] = useState(false);
  const [wtError, setWtError] = useState<string | null>(null);

  // Zero-latency running state for the active session (derive from live nodes
  // rather than waiting for the /api/runs poll); non-active rows use the poll.
  const activeRunning = useSessionStore((s) =>
    Object.values(s.nodes).some((n) => n.status === "streaming"),
  );
  const isRunning = (id: string) =>
    runningIds.has(id) || (id === activeId && activeRunning);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  // 沿用原 collapsed 数组的存储键；与工具条和面板偏好共用安全的 hydration。
  const [collapsedIds, setCollapsedIds] = useSidebarPreference("collapsed", [] as string[], isStringArray);
  const collapsed = useMemo(() => new Set(collapsedIds), [collapsedIds]);
  const [width, setWidth] = useState<number>(loadSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const isDesktopViewport = useIsDesktopViewport();

  // 侧栏自己拥有宽度，就由它来发布 --trellis-sb（原先在 page.tsx 里按常量发，
  // 宽度一旦可拖拽，两处就会打架）。所有消费者读的仍是同一个变量，不用改。
  useEffect(() => {
    const offset = isDesktopViewport && sidebarOpen ? width : 0;
    document.documentElement.style.setProperty("--trellis-sb", `${offset}px`);
  }, [isDesktopViewport, sidebarOpen, width]);

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) =>
      setWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, e.clientX)));
    const onUp = () => {
      setResizing(false);
      setWidth((w) => {
        persistSidebarWidth(w);
        return w;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [resizing]);
  const [editingId, setEditingId] = useState<string | null>(null);

  const toggleCollapsed = (id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return [...next];
    });
  };

  // 会话结构（树与链）缓存与刷新
  const [structures, setStructures] = useState<Map<string, SessionTree[]>>(() => new Map());
  const structuresRef = useRef(structures);
  structuresRef.current = structures;
  const [structureNonce, setStructureNonce] = useState(0);
  const fetchingStructureRef = useRef<Set<string>>(new Set());

  const fetchStructure = useCallback(async (sessionId: string, force = false) => {
    if (fetchingStructureRef.current.has(sessionId)) return;
    if (!force && structuresRef.current.has(sessionId)) return;
    fetchingStructureRef.current.add(sessionId);
    try {
      const r = await fetch(`/api/sessions/${sessionId}/structure`);
      if (r.ok) {
        const data = await r.json();
        setStructures((prev) => {
          const next = new Map(prev);
          next.set(sessionId, (data.trees ?? []) as SessionTree[]);
          return next;
        });
      }
    } catch {
      /* 静默处理 */
    } finally {
      fetchingStructureRef.current.delete(sessionId);
    }
  }, []);

  // 默认折叠状态由树数决定（SN-1）：多树展开到树行（collapsed=false），单树折叠（collapsed=true）
  const isSessionCollapsed = useCallback(
    (sessionId: string, treeCount: number) =>
      resolveSessionCollapsed(sessionId, treeCount, collapsed),
    [collapsed],
  );

  const toggleSessionCollapsed = useCallback(
    (sessionId: string, treeCount: number) => {
      const isCurrentCollapsed = resolveSessionCollapsed(sessionId, treeCount, collapsed);
      setCollapsedIds((prev) =>
        toggleSessionCollapsedState(sessionId, isCurrentCollapsed, prev),
      );
      // 展开时立即拉取该会话结构
      if (isCurrentCollapsed) {
        void fetchStructure(sessionId);
      }
    },
    [collapsed, setCollapsedIds, fetchStructure],
  );

  const isTreeExpanded = useCallback(
    (sessionId: string, rootId: string) =>
      resolveTreeExpanded(sessionId, rootId, collapsed),
    [collapsed],
  );

  const toggleTreeCollapsed = useCallback(
    (sessionId: string, rootId: string) => {
      const isCurrentExpanded = resolveTreeExpanded(sessionId, rootId, collapsed);
      setCollapsedIds((prev) =>
        toggleTreeExpandedState(sessionId, rootId, isCurrentExpanded, prev),
      );
    },
    [collapsed, setCollapsedIds],
  );
  // 已归档：勾「含已归档」时才懒加载归档行；计数随主列表免费带回。
  const [archivedCount, setArchivedCount] = useState(0);
  const [archived, setArchived] = useState<Session[]>([]);
  const bookmarkCount = useSessionStore((s) => s.bookmarksTotal);
  const setBookmarksOpen = useSessionStore((s) => s.setBookmarksOpen);
  const confirm = useConfirm();

  // Same watch contract as SessionPicker / SessionTabs: refetch on active
  // change or any store mutation that bumps sessionsRevision.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/sessions?includeEmptyWorkspaces=1")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setSessions(data.sessions ?? []);
          if (data.pending) useSessionStore.getState().ingestPending(data.pending);
          setArchivedCount(data.archivedCount ?? 0);
          setProjects(data.projects ?? []);
        }
      })
      .catch(() => {
        /* keep last-known list on transient failure */
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, sessionsRevision, fleetSessionKey]);

  // 会话结构的刷新触发 —— 切会话 / 列表变更之外，还看 node 级 key：它能分辨
  // 「同会话 A 刚结束、B 接着运行」与 waiting 状态切换；session 级集合在这两种
  // 情况下都不变。集合每 tick 都是新 Set，折成内容 key。
  const runKey = useMemo(
    () =>
      [
        ...[...waitingNodeIds].sort().map((id) => `w:${id}`),
        ...[...runningNodeIds].sort().map((id) => `r:${id}`),
      ].join(","),
    [runningNodeIds, waitingNodeIds],
  );

  // S1 P2：git 状态（分支 / 脏文件数 / 能不能回收）走独立一路，回来再填角标。
  //
  // 不并进 /api/sessions 是刻意的 —— 那条在流式期间是 ~1.6 次/秒的热循环，
  // 把 spawn git 塞进去会拖垮 SSE；而角标晚一百毫秒出现没人在意。
  //
  // 重扫兄弟 worktree 已经**不在**这个请求里跑了（根因 E：它曾经是每请求
  // 48 次同步 spawn git）。服务端按 repo 节流在后台扫，这里只读它的账。
  //
  // `generation` 是「有净变化的扫描轮次号」。只在它**变化时**才 bump 一次 ——
  // 否则 bump → sessionsRevision 变 → 这个 effect 重跑 → 又拿到同一份
  // added/pruned → 再 bump，「扫到变化 → 刷新 → 再扫」就自己咬住自己了。
  // 首次挂载（seen < 0）不 bump：骨架本来就是刚拉的，没必要再拉一遍。
  const [gitStatus, setGitStatus] = useState<Map<string, WorkspaceGitStatus>>(
    () => new Map(),
  );
  const [gitNonce, setGitNonce] = useState(0);
  const seenRescanGen = useRef(-1);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/workspaces/git-status")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setGitStatus(
          new Map(
            ((data.statuses ?? []) as WorkspaceGitStatus[]).map((s) => [s.id, s]),
          ),
        );
        const gen = Number(data.rescan?.generation ?? 0);
        const seen = seenRescanGen.current;
        if (gen !== seen) {
          seenRescanGen.current = gen;
          if (seen >= 0 && (data.rescan?.added || data.rescan?.pruned)) {
            bumpSessionsRevision();
          }
        }
      })
      .catch(() => {
        /* 角标是锦上添花，拉不到就不显示 */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionsRevision, gitNonce, bumpSessionsRevision]);

  // 切回浏览器时刷一次 —— git 状态几乎总是在**别处**（终端里）被改变的，
  // 而「从终端切回来」正是它可能已经变了的那一刻。比定时轮询精准且省。
  // 会话嵌套结构同样在切回时刷新 —— 活动可能刚在 CLI / 别的标签页里发生。
  useEffect(() => {
    const onFocus = () => {
      setGitNonce((n) => n + 1);
      setStructureNonce((n) => n + 1);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // 只在勾了「含已归档」时拉归档行。任何变更（sessionsRevision）都重拉，
  // 取消归档后行立刻回到正常位置。
  useEffect(() => {
    if (!includeArchived) return;
    let cancelled = false;
    fetch("/api/sessions?archived=1")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setArchived(data.sessions ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [includeArchived, sessionsRevision]);

  // 离线（pane 已不在）的 Herdr 会话按「已归档」对待：默认藏起来，勾选才出现。
  // 纯前端派生 —— 不写库，pane 回来行就自动回来。
  const isOfflineHerdr = useCallback(
    (s: Session) => herdrOffline(s, herdrAvailable, herdrStatus.get(s.id)?.alive),
    [herdrAvailable, herdrStatus],
  );

  const visibleSessions = useMemo(
    () => selectSidebarSessions(sessions, archived, source, includeArchived, isOfflineHerdr),
    [sessions, archived, source, includeArchived, isOfflineHerdr],
  );

  // 会话结构（树与链）懒加载与刷新（SN-2）：
  // 只对当前展开的会话发结构请求；sessionsRevision 变化、运行集合变化、窗口聚焦时刷新已展开会话
  const lastRefreshTriggerRef = useRef("");
  useEffect(() => {
    const currentRefreshTrigger = `${sessionsRevision}:${runKey}:${structureNonce}`;
    const isExplicitRefresh =
      lastRefreshTriggerRef.current !== "" &&
      lastRefreshTriggerRef.current !== currentRefreshTrigger;
    lastRefreshTriggerRef.current = currentRefreshTrigger;

    for (const s of visibleSessions) {
      const treeCount = s.treeCount ?? structuresRef.current.get(s.id)?.length ?? 1;
      if (!isSessionCollapsed(s.id, treeCount)) {
        void fetchStructure(s.id, isExplicitRefresh);
      }
    }
  }, [
    visibleSessions,
    isSessionCollapsed,
    sessionsRevision,
    runKey,
    structureNonce,
    fetchStructure,
  ]);

  // Mobile drawer auto-closes once a session is chosen (activeId changes). The
  // drawer is an overlay, so leaving it open over the loaded session would hide
  // what the user just opened. No-op on desktop (drawer never shown there).
  useEffect(() => {
    setMobileNavOpen(false);
  }, [activeId, setMobileNavOpen]);

  // S1：三级分组。sessions 已按 updated_at DESC 到手，下面只做归位不重排，
  // 所以每个 workspace 内部天然保持「最近活跃在前」。
  //
  // 三个去处：
  //   chat      —— 无 workspace 绑定，仍是平铺一组（它本来就没有「项目」语义）
  //   projects  —— 按 workspace_id 归位
  //   orphans   —— 有 workspace_path 但归不了组（目录已被删）。不能默默吞掉，
  //                否则用户会以为会话丢了。
  const { chat, byWorkspace, orphans } = useMemo(() => {
    const known = new Set(
      projects.flatMap((p) => p.workspaces.map((w) => w.id)),
    );
    const chat: Session[] = [];
    const orphans: Session[] = [];
    const byWorkspace = new Map<string, Session[]>();
    for (const s of visibleSessions) {
      if ((s.mode || "chat") === "chat" && !s.workspaceId) {
        chat.push(s);
        continue;
      }
      const wid = s.workspaceId;
      if (wid && known.has(wid)) {
        const list = byWorkspace.get(wid) ?? [];
        list.push(s);
        byWorkspace.set(wid, list);
      } else {
        orphans.push(s);
      }
    }
    return { chat, byWorkspace, orphans };
  }, [visibleSessions, projects]);

  // 落到「在这个目录下开新会话」的草稿态。侧栏里所有「＋」最终都汇到这里 ——
  // 新建 worktree 之后、以及在一个已有 workspace 行上直接开会话。
  //
  // 这一步是必需的而不是锦上添花：draftWorkspacePath 是从 localStorage 恢复的
  // **上次用过的**路径，不覆盖的话用户点完＋看到的是上一个目录，得再去
  // WorkspacePicker 里把刚才那个找回来 —— 而它恰恰不在「最近」列表里。
  const startSessionIn = (workspacePath: string) => {
    setDraftMode("project");
    setDraftWorkspacePath(workspacePath);
    newConversation();
    setEditingId(null);
    // 抽屉是覆盖层，不收起来就正好挡住刚落下去的 composer。这里显式收，
    // 不能靠 activeId 那个 effect —— 从 composer 态点过来 activeId 本来就是
    // null，不变就不触发。
    setMobileNavOpen(false);
  };

  const createWorktree = async (projectId: string) => {
    const branch = wtBranch.trim();
    if (!branch) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const r = await fetch("/api/workspaces/worktree", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, branch }),
      }).then((x) => x.json());
      if (r.error) {
        setWtError(r.error);
        return;
      }
      setWtFor(null);
      setWtBranch("");
      bumpSessionsRevision(); // 侧栏重拉，新 worktree 当场出现
      // 服务端算出的落点直接接住。以前这里把 r.path 丢了，用户就得拿眼睛把
      // 同一个路径从侧栏搬到 WorkspacePicker 里再选一次 —— 同一个 picker 里
      // 「空白沙箱」「新建文件夹」早就是「创建并使用」，worktree 是唯一一个
      // 建完不选的。
      if (r.path) startSessionIn(r.path);
    } catch {
      setWtError("网络错误");
    } finally {
      setWtBusy(false);
    }
  };

  // 两阶段：先问服务端「删了会没掉什么」，弹给用户看，确认了再带 force=1 回去。
  // 服务端在不带 force 时**只预演不执行** —— 删目录不可逆，而这个按钮在触屏上
  // 是常显的，不能点一下目录就没了。
  const removeWorktree = async (w: { id: string; name: string }) => {
    const r = await fetch(`/api/workspaces/worktree?workspaceId=${w.id}`, {
      method: "DELETE",
    }).then((x) => x.json());
    if (r.ok) {
      // 目录本来就不在了，服务端直接摘了行。
      bumpSessionsRevision();
      return;
    }
    if (!r.preview) {
      toast.error("删除 worktree 失败", { description: r.error ?? "服务端没有给出原因" });
      return;
    }
    // 两类分开说：dirty 是会丢的活；ignored 是 .env / 本地 settings 这类
    // 不进版本库、但删了很痛的东西 —— `git worktree remove` 不当它们是障碍，
    // 连目录一起删，而 git status 默认根本不列它们。
    const detail = (
      <span className="block space-y-2">
        <span className="block break-all font-mono text-label text-ink-faint">{r.path}</span>
        <span className="block">活跃会话：{r.sessionCount ?? 0} 个</span>
        {r.dirtyCount ? (
          <span className="block">
            未提交的改动（{r.dirtyCount} 项）：
            <span className="mt-0.5 block max-h-24 overflow-y-auto font-mono text-label text-ink-faint">
              {(r.dirty as string[]).join("\n")}
            </span>
          </span>
        ) : null}
        {r.ignoredCount ? (
          <span className="block">
            被 .gitignore 忽略、但会一并删掉（{r.ignoredCount} 项）：
            <span className="mt-0.5 block max-h-24 overflow-y-auto font-mono text-label text-ink-faint">
              {(r.ignored as string[]).join("\n")}
            </span>
          </span>
        ) : null}
        {!r.dirtyCount && !r.ignoredCount && <span className="block">工作区是干净的。</span>}
        <span className="block">目录会从磁盘上移除，无法恢复（分支本身保留）。</span>
      </span>
    );
    if (
      !(await confirm({
        title: `删除 worktree「${w.name}」？`,
        description: detail,
        confirmLabel: "删除目录",
        danger: true,
      }))
    )
      return;
    const f = await fetch(
      `/api/workspaces/worktree?workspaceId=${w.id}&force=1`,
      { method: "DELETE" },
    ).then((x) => x.json());
    if (f.error) {
      toast.error("删除 worktree 失败", { description: f.error });
      return;
    }
    bumpSessionsRevision();
  };

  const onNew = () => {
    newConversation();
    setEditingId(null);
    setMobileNavOpen(false);
  };

  // 会话行及其嵌套「树 → 链」两层渲染。
  // 会话行可折叠：多树会话默认展开到树行（树行折叠），单树会话默认折叠。
  const renderRow = (s: Session, indent = 0) => {
    const treeCount = s.treeCount ?? structures.get(s.id)?.length ?? 1;
    const isCollapsed = isSessionCollapsed(s.id, treeCount);
    const sessionTrees = structures.get(s.id);

    return (
      <div key={s.id} data-sidebar-session-item={s.id}>
        <SidebarRow
          session={s}
          indent={indent}
          active={s.id === activeId}
          preview={s.id === previewId}
          running={isRunning(s.id)}
          unread={unreadIds.has(s.id)}
          collapsed={isCollapsed}
          isPinned={pinnedIds.includes(s.id)}
          onToggle={() => toggleSessionCollapsed(s.id, treeCount)}
          location={layout === "time" ? sessionLocation(s, projects) : undefined}
          herdr={sidebarSource(s) === "herdr" ? herdrStatus.get(s.id) ?? { status: "unknown", alive: false, paneId: "" } : undefined}
          offline={isOfflineHerdr(s)}
          live={liveSessionIds.has(s.id)}
          editing={editingId === s.id}
          onPreview={() => { setMobileNavOpen(false); void previewSession(s.id); }}
          onPin={() => pinSession(s.id)}
          onUnpin={() => unpinSession(s.id)}
          onStartEdit={() => setEditingId(s.id)}
          onCancelEdit={() => setEditingId(null)}
          onCommit={async (next) => {
            setEditingId(null);
            if (next.trim() && next.trim() !== s.title) {
              await renameSession(s.id, next);
            }
          }}
          onArchive={() => s.archived ? unarchiveSession(s.id) : archiveSession(s.id)}
          onDelete={async () => {
            if (
              await confirm({
                title: `删除会话「${s.title || "未命名"}」？`,
                description: "会话里的所有节点和笔记会一起删除，无法恢复。只想收起来可以用「归档」。",
                confirmLabel: "删除",
                danger: true,
              })
            ) {
              deleteSession(s.id);
            }
          }}
        />
        {!isCollapsed && sessionTrees && sessionTrees.length > 0 && (
          sessionTrees.length === 1 ? (
            // 只有一棵树的会话不画树行，展开直接列出它的链
            <div data-session-single-tree={s.id}>
              <IndentGuide level={indent}>
                {sessionTrees[0].chains.map((chain) => {
                  const chainLiveStatus = deriveRecentChainStatus(chain, runningNodeIds, waitingNodeIds);
                  return (
                    <ChainRow
                      key={chain.tipId}
                      chain={chain}
                      status={chainLiveStatus}
                      showTree={false}
                      indent={indent + 1}
                      active={s.id === activeId && chain.tipId === activeNodeId}
                      onOpen={() => {
                        setEditingId(null);
                        if (mobileNavOpen) setViewMode("linear");
                        setMobileNavOpen(false);
                        void openNodeInSession(s.id, chain.tipId).catch(() => {});
                      }}
                    />
                  );
                })}
              </IndentGuide>
            </div>
          ) : (
            // 多树会话：列出树行，树行展开下列出链
            <div data-session-trees={s.id}>
              <IndentGuide level={indent}>
                {sessionTrees.map((tree) => {
                  const isTreeOpen = isTreeExpanded(s.id, tree.rootId);
                  let treeLiveStatus: RecentChainStatus = "done";
                  for (const c of tree.chains) {
                    const st = deriveRecentChainStatus(c, runningNodeIds, waitingNodeIds);
                    if (STATUS_PRIORITY[st] > STATUS_PRIORITY[treeLiveStatus]) {
                      treeLiveStatus = st;
                    }
                  }
                  return (
                    <div key={tree.rootId} data-sidebar-tree={tree.rootId}>
                      <TreeRow
                        tree={tree}
                        status={treeLiveStatus}
                        indent={indent + 1}
                        collapsed={!isTreeOpen}
                        active={s.id === activeId && tree.chains.some((c) => c.tipId === activeNodeId)}
                        onToggle={() => toggleTreeCollapsed(s.id, tree.rootId)}
                        onOpen={() => {
                          setEditingId(null);
                          if (mobileNavOpen) setViewMode("linear");
                          setMobileNavOpen(false);
                          if (tree.chains.length > 0) {
                            void openNodeInSession(s.id, tree.chains[0].tipId).catch(() => {});
                          }
                        }}
                      />
                      {isTreeOpen && (
                        <IndentGuide level={indent + 1}>
                          {tree.chains.map((chain) => {
                            const chainLiveStatus = deriveRecentChainStatus(chain, runningNodeIds, waitingNodeIds);
                            return (
                              <ChainRow
                                key={chain.tipId}
                                chain={chain}
                                status={chainLiveStatus}
                                showTree={false}
                                indent={indent + 2}
                                active={s.id === activeId && chain.tipId === activeNodeId}
                                onOpen={() => {
                                  setEditingId(null);
                                  if (mobileNavOpen) setViewMode("linear");
                                  setMobileNavOpen(false);
                                  void openNodeInSession(s.id, chain.tipId).catch(() => {});
                                }}
                              />
                            );
                          })}
                        </IndentGuide>
                      )}
                    </div>
                  );
                })}
              </IndentGuide>
            </div>
          )
        )}
      </div>
    );
  };

  // Chat 也可折叠。用合成 id 走 projects 那套同一个 collapsed 集合，
  // 复用扁平分组状态。
  const renderGroup = (id: string, label: string, list: Session[], icon?: LucideIcon) => {
    if (list.length === 0) return null;
    const isCollapsed = collapsed.has(id);
    return (
      <div className="mb-1.5">
        <GroupRow
          level={0}
          icon={icon}
          collapsed={isCollapsed}
          label={label}
          title={`${label} · ${list.length} 个会话`}
          badge={String(list.length)}
          onToggle={() => toggleCollapsed(id)}
        />
        {!isCollapsed && (
          <IndentGuide level={0}>{list.map((s) => renderRow(s, 1))}</IndentGuide>
        )}
      </div>
    );
  };

  // S1 三级：Project → Workspace → Session。折叠子树时把「藏了几个会话」
  // 回显出来（与树面板折叠行同语义 —— 折叠不该把状态一起藏掉）。
  //
  // 但三级不是恒定的：workspace 那一层**不带信息时就该消失**，否则它只是
  // 白占一级缩进、把真正要扫的会话往里推。两种不带信息的情形（见 isFlat）
  // 走两级渲染 —— Project → Session 直挂。
  const renderWorkspaceItem = (w: WorkspaceSummary, isReclaimable = false) => {
    const list = byWorkspace.get(w.id) ?? [];
    const wCollapsed = collapsed.has(w.id);
    const g = gitStatus.get(w.id);
    const br = g?.branch ?? w.gitBranch;

    return (
      <div key={w.id} data-sidebar-workspace={w.id}>
        <GroupRow
          level={isReclaimable ? 2 : 1}
          icon={GitBranch}
          collapsed={wCollapsed}
          label={w.name}
          // 有 session 才可折叠；空的没有子内容，给三角就是个骗人的开关。
          toggleable={list.length > 0}
          tag={w.kind === "worktree" && !br ? "已脱离" : br && br !== w.name ? br : null}
          git={g ?? null}
          muted={list.length === 0 || isReclaimable}
          title={`${w.path}${(() => {
            return [
              br ? `\n分支: ${br}` : "",
              w.kind === "worktree" && !br
                ? "\n已脱离分支：当前 worktree 没有检出命名分支"
                : "",
              g?.dirty ? `\n${g.dirty} 个文件有改动或未跟踪（点击角标查看改动）` : "",
              g?.reclaimable ? "\n已并入主干且工作区干净 —— 可以安全回收" : "",
            ].join("");
          })()}\n${list.length} 个会话${list.length === 0 ? "（还没在这里开过会话）" : ""}`}
          badge={wCollapsed && list.length > 0 ? String(list.length) : null}
          onToggle={() => toggleCollapsed(w.id)}
          onInspectDiff={
            g?.dirty && g.dirty > 0
              ? () => setDiffTarget({ id: w.id, name: w.name, path: w.path })
              : undefined
          }
          onAdd={() => startSessionIn(w.path)}
          addTitle="在这个工作区下开新会话"
          onRemove={
            w.kind === "worktree"
              ? () => void removeWorktree(w)
              : undefined
          }
        />
        {!wCollapsed && list.length > 0 && (
          <IndentGuide level={isReclaimable ? 2 : 1}>
            {list.map((s) => renderRow(s, isReclaimable ? 3 : 2))}
          </IndentGuide>
        )}
      </div>
    );
  };

  const sidebarProjects = orphans.length > 0 && !projects.some((p) => p.clusterKey === SCRATCH_CLUSTER_KEY)
    ? [...projects, { id: SCRATCH_CLUSTER_KEY, name: "暂存区", clusterKey: SCRATCH_CLUSTER_KEY, gitRemote: null, workspaces: [] }]
    : projects;
  const renderProjects = () =>
    sidebarProjects.map((p) => {
      const presentation = projectPresentation(p);
      const unassigned = p.clusterKey === SCRATCH_CLUSTER_KEY ? orphans : [];
      const pCollapsed = collapsed.has(p.id);
      const pCount = p.workspaces.reduce(
        (n, w) => n + (byWorkspace.get(w.id)?.length ?? 0),
        unassigned.length,
      );
      if (source !== "all" && pCount === 0) return null;
      const { empty: emptyWorkspaces } = partitionEmptyWorkspaces(p.workspaces, byWorkspace);
      const emptyKey = `__empty_${p.id}`;
      const emptyOpen = collapsed.has(emptyKey);
      // 平铺时各 workspace 的会话汇到一起，重新按最近活跃排 —— 每个 list
      // 内部有序不代表拼起来有序。
      const flatList = isFlat(p)
        ? [...p.workspaces.flatMap((w) => byWorkspace.get(w.id) ?? []), ...unassigned]
            .sort((a, b) => b.updatedAt - a.updatedAt)
        : [];
      // 一个会话都没有就别平铺 —— 那会剩下个底下空无一物的项目行，
      // 还不如留着那条灰的 workspace 行说明「这里还没开过会话」。
      const flat = flatList.length > 0;

      // 划分活跃工作区 vs 已合并/可清理工作区
      const activeWorkspaces: WorkspaceSummary[] = [];
      const reclaimableWorkspaces: WorkspaceSummary[] = [];

      for (const w of p.workspaces) {
        if (emptyWorkspaces.includes(w)) continue;
        const g = gitStatus.get(w.id);
        const sessionList = byWorkspace.get(w.id) ?? [];
        const hasRunning = sessionList.some((s) => isRunning(s.id));
        // 已合并且本地无改动、无正在运行会话
        if (g?.reclaimable && !hasRunning && (g?.dirty ?? 0) === 0) {
          reclaimableWorkspaces.push(w);
        } else {
          activeWorkspaces.push(w);
        }
      }

      const reclaimKey = `__reclaim_${p.id}`;
      // 默认折叠已合并分组（不在 collapsed 集合内算折叠）
      const isReclaimCollapsed = !collapsed.has(reclaimKey);

      return (
        <div key={p.id} data-sidebar-project={p.id} className="mb-1.5">
          <GroupRow
            level={0}
            icon={
              p.clusterKey === SCRATCH_CLUSTER_KEY
                ? Inbox
                : p.clusterKey === HOME_CLUSTER_KEY
                  ? House
                  : FolderGit2
            }
            collapsed={pCollapsed}
            label={presentation.name}
            title={`${presentation.description || p.name}${p.gitRemote ? `\n${p.gitRemote}` : ""}\n${
              flat && p.workspaces.length === 1
                ? `${p.workspaces[0].path}\n`
                : `${p.workspaces.length} 个工作区 (${activeWorkspaces.length} 活跃 · ${reclaimableWorkspaces.length} 已合并) · `
            }${pCount} 个会话`}
            badge={pCount > 0 ? String(pCount) : null}
            onToggle={() => toggleCollapsed(p.id)}
            addTitle="新建工作区"
            // 只有 git 项目能开 worktree（暂存区 / 主目录这类 plain 项目不行）
            onAdd={
              p.workspaces.some((w) => w.kind !== "plain")
                ? () => {
                    setWtFor(p.id);
                    setWtBranch("");
                    setWtError(null);
                  }
                : undefined
            }
          />
          {wtFor === p.id && (
            <div className="mx-1 mb-1 rounded-md bg-surface-muted py-1.5 pl-4 pr-2">
              <Input
                size="sm"
                autoFocus
                aria-label="新 worktree 的分支名"
                value={wtBranch}
                onChange={(e) => setWtBranch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createWorktree(p.id);
                  if (e.key === "Escape") setWtFor(null);
                }}
                placeholder="分支名（回车创建 · Esc 取消）"
                invalid={Boolean(wtError)}
              />
              <div className="mt-1 text-nano text-ink-faint">
                {wtBusy
                  ? "创建中…"
                  : wtError
                    ? <span className="text-danger-ink">创建失败：{wtError}</span>
                    : "已有同名分支则直接检出，否则新建；目录落在主目录的同级"}
              </div>
            </div>
          )}
          {!pCollapsed && flat && (
            <IndentGuide level={0}>
              {flatList.map((s) => renderRow(s, 1))}
            </IndentGuide>
          )}
          {!pCollapsed && !flat && (
            <IndentGuide level={0}>
              {activeWorkspaces.map((w) => renderWorkspaceItem(w, false))}
              {reclaimableWorkspaces.length > 0 && (
                <div>
                  <GroupRow
                    level={1}
                    collapsed={isReclaimCollapsed}
                    icon={Check}
                    label="已合并"
                    badge={String(reclaimableWorkspaces.length)}
                    muted
                    title={`已合并的工作区 · ${reclaimableWorkspaces.length} 个\n分支已并入主干且本地干净，可安全批量清理`}
                    onToggle={() => toggleCollapsed(reclaimKey)}
                    onBatchClean={() =>
                      setBatchCleanTarget({
                        ids: reclaimableWorkspaces.map((w) => w.id),
                        projectName: p.name,
                      })
                    }
                    batchCleanTitle="批量清理这组已合并工作区"
                  />
                  {!isReclaimCollapsed && (
                    <IndentGuide level={1}>
                      {reclaimableWorkspaces.map((w) =>
                        renderWorkspaceItem(w, true),
                      )}
                    </IndentGuide>
                  )}
                </div>
              )}
            </IndentGuide>
          )}
          {!pCollapsed && emptyWorkspaces.length > 0 && (
            <IndentGuide level={0}>
              <GroupRow level={1} collapsed={!emptyOpen} label={`其它 ${emptyWorkspaces.length} 个工作区`} title="这些工作区没有符合当前筛选的会话；展开可新建会话、查看分支和清理已合并工作区" badge={null} muted onToggle={() => toggleCollapsed(emptyKey)} />
              {emptyOpen && emptyWorkspaces.map(w => renderWorkspaceItem(w, Boolean(gitStatus.get(w.id)?.reclaimable)))}
            </IndentGuide>
          )}
        </div>
      );
    });

  // 面板主体（新会话 + 工具条 + 树 + 底栏）桌面常驻栏与手机抽屉共用。
  // `onClose` 接到当前容器的收起动作（收起常驻栏 / 关抽屉）。
  const renderPanel = (onClose: () => void) => (
    <>
      <div className="shrink-0 space-y-2 px-2 pb-2 pt-2">
        <div className="flex items-center gap-1.5">
          <Button
            variant="primary"
            data-mobile-target="drawer-new-session"
            onClick={onNew}
            title="新会话：开一棵全新的树（与「新话题」不同——后者在当前会话内清空上下文）"
            className="flex-1"
          >
            <Icon icon={Plus} size="sm" />
            新会话
          </Button>
          {/* CLI 同步：接入本机 Claude Code / Codex 会话（双向）。手机端收在「高级操作」里。 */}
          <IconButton
            label="接入本机 CLI 会话（Claude Code / Codex，双向同步）"
            data-mobile-target="drawer-attach"
            onClick={() => setAttachOpen(true)}
            className="hidden border border-line md:inline-flex"
          >
            <Icon icon={Plug} />
          </IconButton>
          <IconButton
            label="收起侧栏"
            data-mobile-target="drawer-close"
            onClick={onClose}
          >
            <Icon icon={PanelLeftClose} />
          </IconButton>
        </div>

        <div className="md:hidden">
          <button
            type="button"
            data-mobile-target="drawer-advanced"
            aria-expanded={mobileAdvancedOpen}
            onClick={() => setMobileAdvancedOpen((open) => !open)}
            className="flex min-h-11 w-full items-center justify-between rounded-md px-3 text-label text-ink-faint hover:bg-surface-hover"
          >
            <span>高级操作</span>
            <Icon
              icon={ChevronRight}
              size="sm"
              className={`transition-transform duration-150 ${mobileAdvancedOpen ? "rotate-90" : ""}`}
            />
          </button>
          {mobileAdvancedOpen && (
            <Button
              data-mobile-target="drawer-attach"
              onClick={() => setAttachOpen(true)}
              className="mt-1 w-full"
            >
              <Icon icon={Plug} size="sm" />
              接入本机 CLI 会话
            </Button>
          )}
        </div>

        <div data-sidebar-toolbar className="space-y-1.5">
          <SegmentedControl<SidebarLayout>
            aria-label="会话排布"
            fullWidth
            value={layout}
            onValueChange={setLayout}
            options={[
              { value: "project", label: "按项目" },
              { value: "time", label: "按时间" },
            ]}
          />
          <div className="flex items-center gap-2">
            <Select<SidebarSource>
              aria-label="来源"
              size="sm"
              className="min-w-0 flex-1"
              value={source}
              onValueChange={setSource}
              options={SOURCE_OPTIONS}
            />
            <label
              data-sidebar-archived-filter
              title="含已归档的会话，以及 Herdr 里窗格已不存在的离线会话"
              className="flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap text-label text-ink-muted max-md:min-h-11"
            >
              <Checkbox
                checked={includeArchived}
                onCheckedChange={(v) => setIncludeArchived(v === true)}
              />
              含已归档
            </label>
          </div>
        </div>
      </div>

      <div
        data-sidebar-list
        data-sidebar-layout={layout}
        className="flex-1 overflow-y-auto border-t border-line-faint py-1.5"
      >
        {source === "herdr" && !herdrAvailable && (
          <div
            data-herdr-unavailable
            className="mx-2 mb-2 rounded-md border border-line bg-surface px-3 py-2 text-label text-ink-muted"
          >
            {unavailableText}
            <p className="mt-1 text-nano text-ink-faint">
              仍可阅读已同步的会话。启动 Herdr 后会自动恢复状态。
            </p>
          </div>
        )}
        {visibleSessions.length === 0 ? (
          <div className="px-3 py-6 text-center text-label text-ink-faint">
            {source !== "all"
              ? "这个来源还没有会话，切回「全部」看看其它会话"
              : "还没有会话，点上面「新会话」开始"}
          </div>
        ) : layout === "time" ? (
          visibleSessions.map((s) => renderRow(s))
        ) : (
          <>
            {renderProjects()}
            {renderGroup("__chat", "速记（无工作区）", chat, MessageSquare)}
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1 border-t border-line-faint px-2 py-1.5 max-md:hidden">
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={includeArchived}
          title={includeArchived ? "隐藏已归档的会话" : "在树里显示已归档的会话"}
          onClick={() => setIncludeArchived(!includeArchived)}
          className={includeArchived ? "text-ink" : "text-ink-muted"}
        >
          <Icon icon={Archive} size="sm" />
          已归档 <span className="tabular-nums">{archivedCount}</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setBookmarksOpen(true)}
          className="text-ink-muted"
        >
          <Icon icon={Bookmark} size="sm" />
          稍后再读 <span className="tabular-nums">{bookmarkCount}</span>
        </Button>
      </div>
    </>
  );

  return (
    <>
      {attachOpen && (
        <CliAttachPicker
          onClose={() => setAttachOpen(false)}
          onChanged={bumpSessionsRevision}
        />
      )}
      {/* ── Desktop rail ── permanent, pushes content via --trellis-sb. ── */}
      {sidebarOpen ? (
        <aside
          data-sidebar
          className="hidden md:flex fixed left-0 top-12 bottom-0 z-30 flex-col bg-surface-canvas border-r border-line"
          style={{ width }}
        >
          {renderPanel(() => setSidebarOpen(false))}
          {/* 右边缘拖拽调宽 */}
          <div
            onMouseDown={() => setResizing(true)}
            className="absolute top-0 right-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/40"
            aria-hidden
          />
        </aside>
      ) : null}
      {/* 收起后由 Header 左上角的侧栏开关展开（原先左缘中部那条小把手已并入 Header）。 */}

      {/* ── Mobile drawer ── overlay (md:hidden), opened by Header hamburger.
          The sidebar is otherwise invisible on phones, leaving no way to see
          or switch between sessions — this is that entry point. ── */}
      {mobileNavOpen && (
        <div className="md:hidden fixed inset-0 z-50" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-scrim/50 ui-enter-fade"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden
          />
          <aside
            className="absolute left-0 top-0 bottom-0 flex flex-col w-[82vw] max-w-[320px] bg-surface-canvas border-r border-line shadow-overlay ui-enter-slide-left"
          >
            {renderPanel(() => setMobileNavOpen(false))}
          </aside>
        </div>
      )}

      {/* 工作区代码改动检视抽屉/弹窗 */}
      {diffTarget && (
        <WorkspaceDiffModal
          workspaceId={diffTarget.id}
          workspaceName={diffTarget.name}
          workspacePath={diffTarget.path}
          onClose={() => setDiffTarget(null)}
          onStartSession={(p) => startSessionIn(p)}
        />
      )}

      {/* 批量清理已合并工作区弹窗 */}
      {batchCleanTarget && (
        <BatchCleanModal
          open={Boolean(batchCleanTarget)}
          workspaceIds={batchCleanTarget.ids}
          projectName={batchCleanTarget.projectName}
          onClose={() => setBatchCleanTarget(null)}
          onSuccess={() => {
            bumpSessionsRevision();
            setGitNonce((n) => n + 1);
          }}
        />
      )}
    </>
  );
}

// 这个项目的 workspace 那一层该不该显示。判据是**它有没有携带信息**，
// 不是「好不好看」—— 两种情形下它恒为零信息，显示出来只是白占一级缩进、
// 把真正要扫的会话往里推：
//
//   ① 两个伪项目（暂存区 / 主目录，见 types.ts 那两个 key）：workspace
//      名要么是随机词表拼的，要么就是项目名的另一种说法。
//   ② 唯一 workspace 且与项目同名（`.claude` → `.claude`）：纯重复层。
//      刻意排除 worktree —— 那说明项目正在多工作区并行，层级是真的。
//
// 平铺可逆：②的项目一旦多出一个 workspace 就自动恢复三级。
function isFlat(p: ProjectSummary): boolean {
  if (p.clusterKey === SCRATCH_CLUSTER_KEY) return true;
  if (p.clusterKey === HOME_CLUSTER_KEY) return true;
  const only = p.workspaces.length === 1 ? p.workspaces[0] : null;
  return !!only && only.name === p.name && only.kind !== "worktree";
}

// ── 三级树的几何 ──────────────────────────────────────────────────────
// 层次由「缩进 + 引导线 + 字重」承担，**不由字号**：三级同为 text-ui。
// 之前 workspace 用 11px 而 session 用 12.5px，父级比子级还轻，层次是倒挂的。
//
// 行一律通栏 pill（mx-1 + 圆角），只有内容缩进 —— 这样 hover / 选中高亮不会
// 随层级越缩越窄，长标题也不会在深层被挤没。
// 三级统一行高；原先 group 24 / session 28 又是一处倒挂。
const ROW_HEIGHT_CLASS = "h-7 max-md:h-11";
const PAD = (level: number) => 6 + level * 12; // 内容缩进：6 / 18 / 30
const CHEVRON_MID = (level: number) => 4 /* mx-1 */ + PAD(level) + 5;

// 子树左侧的竖引导线，对齐父行三角的中心。文件树的标准读法：一眼看出
// 「这几行归谁管」，比单纯拉大缩进更省横向空间。
function IndentGuide({
  level,
  children,
}: {
  level: number;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <span
        aria-hidden
        className="absolute top-0 bottom-0 w-px bg-line"
        style={{ left: CHEVRON_MID(level) }}
      />
      {children}
    </div>
  );
}

// S1：Project / Workspace 的分组行。两级共用一个组件，靠 level 调缩进与字重
// —— 项目行是这棵树的骨架（强），工作区行是它的分支（弱）。
//
// 外层刻意是 div 而非 button：行上要挂「+ 新建 worktree」「删除」这类操作，
// button 里套 button 是非法 HTML（SidebarRow 同款处理）。
/**
 * workspace 行右侧的 git 角标：脏文件数 · 可回收。点脏文件数直接打开改动检视。
 * 中性小字 + 状态点，不再用饱和色字块抢眼。
 */
function GitBadge({
  git,
  onInspectDiff,
}: {
  git: WorkspaceGitStatus;
  onInspectDiff?: () => void;
}) {
  if (!git.dirty && !git.reclaimable) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 text-nano text-ink-faint">
      {git.dirty > 0 && (
        <button
          type="button"
          onClick={(e) => {
            if (onInspectDiff) {
              e.stopPropagation();
              onInspectDiff();
            }
          }}
          title={`${git.dirty} 个文件有改动或未跟踪（点击查看改动）`}
          aria-label={`${git.dirty} 个文件有改动，查看改动`}
          className={`inline-flex items-center gap-1 rounded-sm px-1 tabular-nums hover:bg-surface-muted hover:text-ink ${
            onInspectDiff ? "cursor-pointer" : ""
          }`}
        >
          <StatusDot tone="warn" />
          {git.dirty}
        </button>
      )}
      {git.reclaimable && (
        <span title="已并入主干且工作区干净，可以安全回收" className="inline-flex">
          <Icon icon={Check} size="sm" />
        </span>
      )}
    </span>
  );
}

// 行尾的 meta（计数 / 分支 / 时间）与 hover 才出现的操作按钮共用同一块位置：
// meta 在 hover 时只变透明、不让出宽度，操作按钮叠在它上面 —— 行内容不会因为
// hover 而重排（W4 之前三个按钮挤进来，标题截断点跟着跳，看起来整行在「闪」）。
// 触屏（pointer-coarse）没有 hover，操作按钮常驻、正常占位。
const META_FADE = "transition-opacity duration-100 md:group-hover:opacity-0 md:group-focus-within:opacity-0";
const ACTIONS_OVERLAY =
  "absolute inset-y-0 right-1 hidden items-center gap-0.5 rounded-md bg-surface-hover pl-1 md:group-hover:flex md:group-focus-within:flex";

// Project / Workspace 的分组行。两级共用一个组件，靠 level 调缩进与字重 ——
// 项目行是这棵树的骨架（强），工作区行是它的分支（弱）。外层刻意是 div 而非
// button：行上要挂「新建 worktree」「删除」这类操作，button 里套 button 不合法。
function GroupRow({
  level,
  icon,
  collapsed,
  label,
  title,
  badge,
  tag,
  git,
  muted,
  toggleable = true,
  onToggle,
  onAdd,
  addTitle = "在这个项目下新建 worktree",
  onInspectDiff,
  diffTitle = "查看工作区代码改动",
  onBatchClean,
  batchCleanTitle = "批量清理已合并工作区",
  onRemove,
  removeTitle = "删除这个 worktree（会先列出将被删掉的东西）",
}: {
  level: number;
  icon?: LucideIcon;
  collapsed: boolean;
  label: string;
  title: string;
  badge: string | null;
  tag?: string | null;
  git?: WorkspaceGitStatus | null;
  muted?: boolean;
  toggleable?: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  /** ＋ 在两级上意思不同：project 级是「开 worktree」，workspace 级是「开会话」 */
  addTitle?: string;
  onInspectDiff?: () => void;
  diffTitle?: string;
  onBatchClean?: () => void;
  batchCleanTitle?: string;
  onRemove?: () => void;
  removeTitle?: string;
}) {
  const menu = useContextMenuWithTarget<string>();
  const menuItems = useMemo<ContextMenuItem[]>(() => {
    const items: ContextMenuItem[] = [];
    if (toggleable && onToggle) {
      items.push({ label: collapsed ? "展开" : "收起", onSelect: onToggle });
    }
    if (onAdd) items.push({ label: addTitle, onSelect: onAdd });
    if (onInspectDiff) items.push({ label: diffTitle, onSelect: onInspectDiff });
    if (onBatchClean) items.push({ label: batchCleanTitle, danger: true, onSelect: onBatchClean });
    if (onRemove) {
      items.push({
        label: removeTitle ? removeTitle.split("（")[0] : "删除工作区",
        danger: true,
        onSelect: onRemove,
      });
    }
    return items;
  }, [toggleable, onToggle, collapsed, onAdd, addTitle, onInspectDiff, diffTitle, onBatchClean, batchCleanTitle, onRemove, removeTitle]);
  const hasActions = Boolean(onAdd || onInspectDiff || onBatchClean || onRemove);

  return (
    <>
      <div
        data-sidebar-group
        {...(menuItems.length > 0 ? menu.bindTrigger(label) : {})}
        className={`${ROW_HEIGHT_CLASS} group relative mx-1 flex items-center gap-1 rounded-md pr-1.5 ${
          toggleable ? "hover:bg-surface-hover" : ""
        } ${muted ? "opacity-70" : ""}`}
      >
        <button
          onClick={toggleable ? onToggle : undefined}
          aria-expanded={toggleable ? !collapsed : undefined}
          title={title}
          style={{ paddingLeft: PAD(level) }}
          className={`flex h-full min-w-0 flex-1 items-center gap-1.5 text-left text-ui ${
            toggleable ? "" : "cursor-default"
          } ${level === 0 ? "font-medium text-ink-strong" : "text-ink"}`}
        >
          <Icon
            icon={ChevronRight}
            size="sm"
            className={`-mr-0.5 text-ink-faint transition-transform duration-150 ${
              collapsed ? "" : "rotate-90"
            } ${toggleable ? "" : "opacity-0"}`}
          />
          {icon && <Icon icon={icon} size="sm" className="text-ink-muted" />}
          <span className="min-w-8 flex-1 truncate">{label}</span>
        </button>
        <span className={`flex min-w-0 shrink items-center gap-1.5 ${hasActions ? META_FADE : ""}`}>
          {tag && (
            <span className="min-w-0 max-w-16 truncate font-mono text-nano text-ink-faint" title={tag}>
              {tag}
            </span>
          )}
          {git && <GitBadge git={git} onInspectDiff={onInspectDiff} />}
          {badge && <span className="text-nano tabular-nums text-ink-faint">{badge}</span>}
        </span>
        {hasActions && (
          <div className={`${ACTIONS_OVERLAY} pointer-coarse:static pointer-coarse:flex pointer-coarse:bg-transparent`}>
            {onInspectDiff && (
              <RowIconButton title={diffTitle} icon={FileDiff} onClick={onInspectDiff} />
            )}
            {onBatchClean && (
              <RowIconButton title={batchCleanTitle} icon={BrushCleaning} onClick={onBatchClean} />
            )}
            {onAdd && <RowIconButton title={addTitle} icon={Plus} onClick={onAdd} />}
            {onRemove && (
              <RowIconButton title={removeTitle} icon={Trash2} danger onClick={onRemove} />
            )}
          </div>
        )}
      </div>
      {menuItems.length > 0 && (
        <ContextMenu {...menu.props} items={menuItems} label={`${label} 菜单`} />
      )}
    </>
  );
}

// 来源 → 图标。lib/session-source.ts 的 label 还是 emoji（被别处复用），侧栏
// 只取它的 title 当说明文字，图标在这里映射。
const SOURCE_ICON: Partial<Record<SidebarSource, LucideIcon>> = {
  herdr: Anchor,
  task: CalendarClock,
  lark: MessageSquare,
};

const SOURCE_OPTIONS: { value: SidebarSource; label: string }[] = [
  { value: "all", label: "全部来源" },
  { value: "web", label: "网页" },
  { value: "herdr", label: "Herdr" },
  { value: "task", label: "定时任务" },
  { value: "lark", label: "飞书" },
  { value: "external", label: "外部" },
];

// 行首状态槽：一行只有一个状态记号，紧急度 等你回答 > 生成中 > 出错 > 未读。
// 固定宽度，状态切换时标题不左右挪。
function StatusSlot({ status }: { status: RecentChainStatus | "done" }) {
  return (
    <span className="flex w-3.5 shrink-0 items-center justify-center">
      {status === "waiting" ? (
        <Icon icon={CircleHelp} size="sm" className="text-accent-ink" aria-label="等你回答" />
      ) : status === "streaming" ? (
        <Dots />
      ) : status === "error" ? (
        <StatusDot tone="danger" label="出错" />
      ) : status === "unread" ? (
        <StatusDot tone="unread" label="完成·未读" />
      ) : null}
    </span>
  );
}

function SidebarRow({
  session,
  indent = 0,
  active,
  preview,
  running,
  unread,
  collapsed,
  isPinned,
  onToggle,
  location,
  herdr,
  offline,
  live,
  editing,
  onPreview,
  onPin,
  onUnpin,
  onStartEdit,
  onCancelEdit,
  onCommit,
  onArchive,
  onDelete,
}: {
  session: Session;
  /** 缩进层级：1 = 挂在速记 / 暂存区下，2 = 挂在 Project → Workspace 下 */
  indent?: number;
  active: boolean;
  preview: boolean;
  running: boolean;
  unread: boolean;
  collapsed?: boolean;
  isPinned?: boolean;
  onToggle?: () => void;
  location?: string;
  herdr?: HerdrSessionStatus;
  /** Herdr 在线但这个会话的窗格已不存在 —— 与 archived 同档对待。 */
  offline?: boolean;
  live: boolean;
  editing: boolean;
  onPreview: () => void;
  onPin: () => void;
  onUnpin?: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onCommit: (title: string) => void | Promise<void>;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(session.title);
  const source = sidebarSource(session);
  const sourceChip = sessionSourceChip(session);
  const SourceIcon = SOURCE_ICON[source];
  const indicatorStatus: RecentChainStatus | "done" =
    herdr?.alive && (herdr.status === "waiting" || herdr.status === "blocked")
      ? "waiting"
      : running || (herdr?.alive && herdr.status === "working")
        ? "streaming"
        : unread
          ? "unread"
          : "done";
  const statusTitle =
    indicatorStatus === "waiting"
      ? "等你回答"
      : indicatorStatus === "streaming"
        ? "生成中…"
        : indicatorStatus === "unread"
          ? "完成·未读"
          : "";

  const menu = useContextMenuWithTarget<Session>();
  const menuItems = useMemo<ContextMenuItem[]>(() => [
    {
      label: isPinned ? "取消固定" : "固定会话",
      onSelect: isPinned ? (onUnpin ?? onPin) : onPin,
    },
    { label: "重命名", onSelect: onStartEdit },
    { label: session.archived ? "恢复（取消归档）" : "归档", onSelect: onArchive },
    { label: "删除…", danger: true, onSelect: onDelete },
  ], [isPinned, onUnpin, onPin, session.archived, onStartEdit, onArchive, onDelete]);

  useEffect(() => {
    if (editing) {
      setDraft(session.title);
      const t = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return () => window.clearTimeout(t);
    }
  }, [editing, session.title]);

  // 行尾 meta：全是中性小字。优先级从左到右 = 来源 · 话题数 · 状态文字。
  const meta: React.ReactNode[] = [];
  if (!editing) {
    if (session.origin === "cli-import") {
      meta.push(
        <span
          key="cli"
          className="inline-flex items-center gap-1"
          title={
            live
              ? `正被一个活的 ${session.cliProvider === "codex" ? "Codex" : "Claude"} 进程实时驱动`
              : "已接入的本机 CLI 会话（双向同步）"
          }
        >
          {live && <StatusDot tone="live" />}
          {session.cliProvider === "codex" ? "Codex" : "CLI"}
        </span>,
      );
    } else if (SourceIcon) {
      meta.push(
        <span key="src" className="inline-flex" title={sourceChip?.title} aria-label={sourceChip?.title}>
          <Icon icon={SourceIcon} size="sm" />
        </span>,
      );
    } else if (sourceChip) {
      meta.push(<span key="src" title={sourceChip.title}>{sourceChip.label}</span>);
    }
    if (herdr) {
      meta.push(
        <span
          key="herdr"
          data-herdr-alive={herdr.alive}
          className="inline-flex"
          title={herdr.alive ? `Herdr 在线 · ${herdr.status}` : "Herdr 离线 · 可阅读历史"}
        >
          <StatusDot
            tone={
              herdr.alive
                ? herdr.status === "waiting" || herdr.status === "blocked"
                  ? "warn"
                  : "positive"
                : "idle"
            }
            label={herdr.alive ? "Herdr 在线" : "Herdr 离线"}
          />
        </span>,
      );
    }
    if ((session.treeCount ?? 0) > 1) {
      meta.push(
        <span key="trees" className="tabular-nums" title={`${session.treeCount} 个话题，进入会话后在思维树切换`}>
          {session.treeCount} 个话题
        </span>,
      );
    }
    if (session.archived) meta.push(<span key="arch">已归档</span>);
    if (offline) {
      meta.push(
        <span
          key="off"
          data-session-offline
          title="Herdr 里的窗格已不存在，按已归档对待；窗格回来这行自动回来"
        >
          离线
        </span>,
      );
    }
  }

  return (
    <>
      <div
        style={{ paddingLeft: PAD(indent) }}
        data-mobile-target="session-row"
        data-session-id={session.id}
        data-session-source={source}
        data-session-archived={session.archived || undefined}
        data-session-status={indicatorStatus}
        data-herdr-pane={herdr?.paneId || undefined}
        data-herdr-status={herdr ? herdr.alive ? herdr.status : "offline" : undefined}
        aria-current={active ? "true" : undefined}
        {...(editing ? {} : menu.bindTrigger(session))}
        className={`${location ? "h-11" : ROW_HEIGHT_CLASS} ${session.archived || offline ? "opacity-55" : ""} group relative mx-1 flex cursor-pointer items-center gap-1.5 overflow-hidden rounded-md pr-1.5 transition-colors ${
          active
            ? "bg-accent-muted text-ink-strong"
            : "text-ink hover:bg-surface-hover"
        } ${indicatorStatus === "unread" ? "font-medium" : ""}`}
        onClick={editing ? undefined : onPreview}
        onDoubleClick={editing ? undefined : onPin}
        title={`${session.title}${statusTitle ? `\n${statusTitle}` : ""}\n单击预览 · 双击固定`}
      >
        {/* 当前会话：左缘一条强调色竖线（与 mockup 一致），不再给运行中的行整行染色。 */}
        {active && (
          <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent" aria-hidden />
        )}
        <button
          type="button"
          data-testid="session-collapse-toggle"
          aria-label={collapsed ? "展开会话结构" : "收起会话结构"}
          onClick={(e) => {
            e.stopPropagation();
            onToggle?.();
          }}
          // 折叠态的三角只在 hover / 键盘聚焦时出现：一栏几十行、每行一个三角是噪音；
          // 展开态常显，标明「下面挂着的是它的树 / 链」。
          className={`-ml-1 flex size-3.5 shrink-0 items-center justify-center text-ink-faint hover:text-ink focus-visible:opacity-100 ${
            collapsed ? "opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100" : ""
          }`}
        >
          <Icon
            icon={ChevronRight}
            size="sm"
            className={`transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`}
          />
        </button>
        <StatusSlot status={indicatorStatus} />

        {editing ? (
          <Input
            ref={inputRef}
            size="sm"
            aria-label="会话名称"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onCommit(draft);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancelEdit();
              }
            }}
            onBlur={() => onCommit(draft)}
            className="min-w-0 flex-1"
          />
        ) : (
          <span
            className={`min-w-0 flex-1 truncate text-ui ${
              // 预览（未固定、临时）的会话读作斜体，同 VSCode。
              preview ? "italic" : ""
            } ${preview && !active ? "text-ink-muted" : ""}`}
          >
            {session.title}
            {location && (
              <span className="block truncate text-nano font-normal not-italic text-ink-faint" title={location}>
                {location}
              </span>
            )}
          </span>
        )}

        {meta.length > 0 && (
          <span className={`flex shrink-0 items-center gap-1.5 text-nano text-ink-faint ${META_FADE}`}>
            {meta}
          </span>
        )}

        {!editing && (
          <div className={`${ACTIONS_OVERLAY} ${active ? "bg-accent-muted" : ""} max-md:!hidden`}>
            <SessionRowMenu
              isPinned={Boolean(isPinned)}
              archived={session.archived}
              onPin={onPin}
              onUnpin={onUnpin ?? onPin}
              onRename={onStartEdit}
              onArchive={onArchive}
              onDelete={onDelete}
            />
          </div>
        )}
      </div>
      {!editing && (
        <ContextMenu {...menu.props} items={menuItems} label={`${session.title} 菜单`} />
      )}
    </>
  );
}

// 会话行尾的「更多」：与右键菜单同一套动作。hover 时才出现，占 meta 的位置。
function SessionRowMenu({
  isPinned,
  archived,
  onPin,
  onUnpin,
  onRename,
  onArchive,
  onDelete,
}: {
  isPinned: boolean;
  archived: boolean;
  onPin: () => void;
  onUnpin: () => void;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="会话操作"
          title="会话操作"
          data-session-row-more
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          className="inline-flex size-6 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-muted hover:text-ink aria-expanded:bg-surface-muted"
        >
          <Icon icon={Ellipsis} size="sm" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem icon={<Icon icon={isPinned ? PinOff : Pin} />} onSelect={isPinned ? onUnpin : onPin}>
          {isPinned ? "取消固定" : "固定会话"}
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Icon icon={Pencil} />} onSelect={onRename}>
          重命名
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Icon icon={archived ? ArchiveRestore : Archive} />} onSelect={onArchive}>
          {archived ? "恢复（取消归档）" : "归档"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem danger icon={<Icon icon={Trash2} />} onSelect={onDelete}>
          删除…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TreeRow({
  tree,
  status,
  indent = 2,
  collapsed,
  active,
  onToggle,
  onOpen,
}: {
  tree: SessionTree;
  status: RecentChain["status"];
  indent?: number;
  collapsed: boolean;
  active: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const time = formatRelativeTimeShort(tree.activityAt);
  const menu = useContextMenuWithTarget<SessionTree>();
  const menuItems = useMemo<ContextMenuItem[]>(() => [
    { label: "打开该树", onSelect: onOpen },
    { label: collapsed ? "展开树分支" : "收起树分支", onSelect: onToggle },
  ], [collapsed, onOpen, onToggle]);

  return (
    <>
      <div
        data-sidebar-tree-row
        data-root-id={tree.rootId}
        {...menu.bindTrigger(tree)}
        onClick={onOpen}
        style={{ paddingLeft: PAD(indent) }}
        className={`${ROW_HEIGHT_CLASS} group relative mx-1 flex cursor-pointer items-center gap-1.5 overflow-hidden rounded-md pr-1.5 transition-colors ${
          active ? "bg-surface-hover text-ink-strong" : "text-ink hover:bg-surface-hover"
        }`}
        title={`${tree.treeLabel}\n${tree.nodeCount} 个节点 · ${time}\n点击打开该树最近的链尾`}
      >
        <button
          type="button"
          data-testid="tree-collapse-toggle"
          aria-label={collapsed ? "展开树分支" : "收起树分支"}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="-ml-1 flex size-3.5 shrink-0 items-center justify-center text-ink-faint hover:text-ink"
        >
          <Icon
            icon={ChevronRight}
            size="sm"
            className={`transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`}
          />
        </button>
        <StatusSlot status={status} />
        <span className="min-w-0 flex-1 truncate text-ui">{tree.treeLabel}</span>
        <span className="shrink-0 text-nano tabular-nums text-ink-faint">
          {tree.nodeCount} 节 · {time}
        </span>
      </div>
      <ContextMenu {...menu.props} items={menuItems} label={`${tree.treeLabel} 菜单`} />
    </>
  );
}

// 会话 / 树展开后的链行：「[树名 › ]链尾标签 · 时间」。状态编码整条 lineage，
// 紧急度降序：等你回答 > 生成中 > 出错 > 未读点 —— 与树面板树行的 rollup 同一套读法。
function ChainRow({
  chain,
  status,
  showTree,
  active,
  indent = 2,
  onOpen,
}: {
  chain: RecentChain | SessionTreeChain;
  status: RecentChain["status"];
  showTree: boolean;
  active: boolean;
  indent?: number;
  onOpen: () => void;
}) {
  const time = formatRelativeTimeShort(chain.activityAt);
  // 单节点树的链尾就是根：树名 = 链尾标签，前缀只会把同一句话说两遍。
  const withTree = showTree && chain.tipId !== chain.rootId;
  const statusNote =
    status === "waiting"
      ? " · 等你回答"
      : status === "streaming"
        ? " · 生成中"
        : status === "error"
          ? " · 出错"
          : status === "unread"
            ? " · 未读"
            : "";

  const menu = useContextMenuWithTarget<RecentChain | SessionTreeChain>();
  const menuItems = useMemo<ContextMenuItem[]>(() => [{ label: "打开此链", onSelect: onOpen }], [onOpen]);

  return (
    <>
      <button
        type="button"
        data-mobile-target="session-chain-row"
        data-tip-id={chain.tipId}
        onClick={onOpen}
        {...menu.bindTrigger(chain)}
        style={{ paddingLeft: PAD(indent) }}
        // button 的 display:flex 只让它成为 flex 容器，宽度仍按内容算（不像 div
        // 会撑满）；不显式给宽，长标签就不 truncate、时间被挤出侧栏右缘。
        className={`${ROW_HEIGHT_CLASS} mx-1 flex w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-md pr-1.5 text-left transition-colors ${
          active ? "bg-surface-hover text-ink-strong" : "text-ink-muted hover:bg-surface-hover hover:text-ink"
        }`}
        title={`${withTree && "treeLabel" in chain ? `${chain.treeLabel} › ` : ""}${chain.label}\n${chain.depth} 轮${statusNote} · ${time}\n点击落到这条链的链尾`}
      >
        <StatusSlot status={status} />
        <span className="min-w-0 flex-1 truncate text-ui">
          {withTree && "treeLabel" in chain && (
            <span className="text-ink-faint">{chain.treeLabel} › </span>
          )}
          {chain.label}
        </span>
        <span className="shrink-0 text-nano tabular-nums text-ink-faint">{time}</span>
      </button>
      <ContextMenu {...menu.props} items={menuItems} label={`${chain.label} 菜单`} />
    </>
  );
}

function RowIconButton({
  title,
  icon,
  danger,
  onClick,
}: {
  title: string;
  icon: LucideIcon;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      title={title}
      aria-label={title}
      className={`inline-flex size-6 items-center justify-center rounded-sm max-md:size-11 ${
        danger
          ? "text-ink-muted hover:bg-danger-muted hover:text-danger-ink"
          : "text-ink-muted hover:bg-surface-muted hover:text-ink"
      }`}
    >
      <Icon icon={icon} size="sm" />
    </button>
  );
}
