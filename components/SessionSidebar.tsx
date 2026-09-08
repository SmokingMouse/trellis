"use client";
import { STRUCTURE_PANEL } from "@/lib/structure-panel";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSessionStore } from "@/stores/sessionStore";
import { modeStyle } from "@/lib/mode-style";
import { Dots } from "@/components/ui/Dots";
import { CliAttachPicker } from "@/components/CliAttachPicker";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import {
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  loadSidebarWidth,
  persistSidebarWidth,
} from "@/lib/workbench-layout";
import { useIsDesktopViewport } from "@/hooks/useIsMobile";
import { formatRelativeTimeShort } from "@/lib/relative-time";
import {
  RECENT_CHAINS_SHOWN,
  deriveRecentChainStatus,
  orderRecentChains,
  recentSessionStatus,
} from "@/lib/recent";
import {
  HOME_CLUSTER_KEY,
  SCRATCH_CLUSTER_KEY,
  type ProjectSummary,
  type RecentChain,
  type RecentSession,
  type WorkspaceSummary,
  type Session,
  type WorkspaceGitStatus,
} from "@/lib/types";
import { WorkspaceDiffModal } from "@/components/WorkspaceDiffModal";
import { BatchCleanModal } from "@/components/BatchCleanModal";
import { sessionSourceChip } from "@/lib/session-source";
import { HerdrSidebarGroup } from "@/components/HerdrSidebarGroup";
import { useHerdrSessionStatuses } from "@/hooks/useHerdrFleet";
import { type HerdrSessionStatus } from "@/lib/herdr-ui";
import { isBoolean, isStringArray, useSidebarPreference } from "@/hooks/useSidebarPreference";
import { SIDEBAR_V2, selectSidebarSessions, sessionLocation, sidebarSource, projectPresentation, partitionEmptyWorkspaces, type SidebarLayout, type SidebarSource } from "@/lib/sidebar-view";

const isLayout = (v: unknown): v is SidebarLayout => v === "project" || v === "time";
const isSource = (v: unknown): v is SidebarSource => ["all", "web", "herdr", "task", "lark", "external"].includes(v as string);

// Workbench Wave 4 — VSCode-style left explorer sidebar (R1 + R2 + R3).
//
//  R1  Always-present desktop rail (md:block, ~210px). Lists every
//      unarchived session grouped by mode (Chat / Project),
//      each row: mode color dot + truncated title + running pulse /
//      unread badge. Active row highlighted. Collapsible (toggle persists
//      to localStorage via store.sidebarOpen); collapsed → rail hidden +
//      content offset removed (page.tsx reads sidebarOpen).
//  R2  Prominent "+ 新建会话" button at the top — the primary "open a new
//      canvas / tree" entry, fixing "I can't find how to add a canvas".
//  R3  Each row shows the same running pulse (blue) + finished-while-away
//      unread badge (emerald) as the tabs, read from the central poll.
//
//  Interaction: single-click = previewSession (transient/italic), double-
//  click = pinSession (permanent). Hover reveals rename/archive/delete so
//  the SessionPicker's management powers aren't lost.

export function SessionSidebar() {
  const [layout, setLayout] = useSidebarPreference("layout", "project" as SidebarLayout, isLayout);
  const [source, setSource] = useSidebarPreference("source", "all" as SidebarSource, isSource);
  const [includeArchived, setIncludeArchived] = useSidebarPreference("include-archived", false, isBoolean);
  const { statuses: herdrStatus, available: herdrAvailable, unavailableText } = useHerdrSessionStatuses();
  const fleetSessionKey = [...herdrStatus.keys()].sort().join(",");
  const router = useRouter();
  const activeId = useSessionStore((s) => s.session?.id ?? null);
  const previewId = useSessionStore((s) => s.previewSessionId);
  const previewSession = useSessionStore((s) => s.previewSession);
  const pinSession = useSessionStore((s) => s.pinSession);
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
  // S133：「最近」分组 —— 最近活动的会话，粒度到链（根→叶子 lineage）。走
  // 独立一路 /api/recent（递归 CTE），不并进 /api/sessions 的热路径；归组 /
  // 截断规则见 lib/recent.ts。
  const [recent, setRecent] = useState<RecentSession[]>([]);
  // 点开了「还有 N 条链」的会话 id。刻意不持久化：那是一次性的「再看两眼」，
  // 不是偏好。
  const [recentExpanded, setRecentExpanded] = useState<Set<string>>(
    () => new Set(),
  );
  const [recentNonce, setRecentNonce] = useState(0);
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
  // Archived view (replaces SessionPicker's "显示已归档" toggle). Count comes
  // free from the main list response; the archived rows are fetched lazily
  // only when the footer is expanded.
  const [archivedCount, setArchivedCount] = useState(0);
  const [archivedOpen, setArchivedOpen] = useSidebarPreference("archived-open", false, isBoolean);
  const [archived, setArchived] = useState<Session[]>([]);

  // Same watch contract as SessionPicker / SessionTabs: refetch on active
  // change or any store mutation that bumps sessionsRevision.
  useEffect(() => {
    let cancelled = false;
    fetch(SIDEBAR_V2 ? "/api/sessions?includeEmptyWorkspaces=1" : "/api/sessions")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setSessions(data.sessions ?? []);
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

  // S133：最近分组的刷新触发 —— 切会话 / 列表变更（与主列表同）之外，还看
  // node 级 key 能分辨「同会话 A 刚结束、B 接着运行」与 waiting 状态切换；
  // session 级集合在这两种情况下都不变。集合每 tick 都是新 Set，折成内容 key。
  const recentRunKey = useMemo(
    () =>
      [
        ...[...waitingNodeIds].sort().map((id) => `w:${id}`),
        ...[...runningNodeIds].sort().map((id) => `r:${id}`),
      ].join(","),
    [runningNodeIds, waitingNodeIds],
  );
  useEffect(() => {
    if (SIDEBAR_V2) return;
    let cancelled = false;
    fetch("/api/recent")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setRecent(data.sessions ?? []);
      })
      .catch(() => {
        /* 保留上一份 —— 最近分组是导航捷径，拉不到就沿用旧的 */
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, sessionsRevision, recentRunKey, recentNonce]);

  // S1 P2：git 状态（分支 / 脏文件数 / 能不能回收）走独立一路，回来再填角标。
  //
  // 不并进 /api/sessions 是刻意的 —— 那条在流式期间是 ~1.6 次/秒的热循环，
  // 把 spawn git 塞进去会拖垮 SSE；而角标晚一百毫秒出现没人在意。
  //
  // 这一路还顺带触发服务端重扫兄弟 worktree，所以它也是「CLI 里新建的
  // worktree 出现在侧栏」的通道。重扫真有增删时 bump 一次让骨架重拉；
  // 重扫幂等，第二趟 added/pruned 归零，不会反复触发。
  const [gitStatus, setGitStatus] = useState<Map<string, WorkspaceGitStatus>>(
    () => new Map(),
  );
  const [gitNonce, setGitNonce] = useState(0);
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
        if (data.rescan?.added || data.rescan?.pruned) bumpSessionsRevision();
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
  // S133：最近分组同一时机刷新 —— 活动可能刚在 CLI / 别的 tab 里发生。
  useEffect(() => {
    const onFocus = () => {
      setGitNonce((n) => n + 1);
      setRecentNonce((n) => n + 1);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Lazy-load archived rows only while the footer is open. Re-runs on any
  // mutation (sessionsRevision) so unarchiving instantly removes the row.
  useEffect(() => {
    if (!(SIDEBAR_V2 ? includeArchived : archivedOpen)) return;
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
  }, [archivedOpen, includeArchived, sessionsRevision]);

  const visibleSessions = useMemo(() => SIDEBAR_V2
    ? selectSidebarSessions(sessions, archived, source, includeArchived)
    : sessions, [sessions, archived, source, includeArchived]);

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
      alert(`删除失败：${r.error ?? "未知错误"}`);
      return;
    }
    // 两类分开说：dirty 是会丢的活；ignored 是 .env / 本地 settings 这类
    // 不进版本库、但删了很痛的东西 —— `git worktree remove` 不当它们是障碍，
    // 连目录一起删，而 git status 默认根本不列它们。
    const parts: string[] = [];
    parts.push(`活跃会话：${r.sessionCount ?? 0} 个`);
    if (r.dirtyCount)
      parts.push(`未提交的改动（${r.dirtyCount} 项）：\n${r.dirty.join("\n")}`);
    if (r.ignoredCount)
      parts.push(
        `被 .gitignore 忽略、但会一并删掉（${r.ignoredCount} 项）：\n${r.ignored.join("\n")}`,
      );
    const detail = parts.length ? `\n\n${parts.join("\n\n")}` : "\n\n工作区是干净的。";
    if (
      !confirm(
        `删除 worktree「${w.name}」？\n${r.path}${detail}\n\n目录会从磁盘上移除，不可恢复（分支本身保留）。`,
      )
    )
      return;
    const f = await fetch(
      `/api/workspaces/worktree?workspaceId=${w.id}&force=1`,
      { method: "DELETE" },
    ).then((x) => x.json());
    if (f.error) {
      alert(`删除失败：${f.error}`);
      return;
    }
    bumpSessionsRevision();
  };

  const onNew = () => {
    newConversation();
    setEditingId(null);
    setMobileNavOpen(false);
  };

  // 单行渲染。indent 让它能在 Chat（平铺）与 Project→Workspace（缩两级）
  // 两种上下文里复用同一个组件，缩进不进 SidebarRow 内部。
  const renderRow = (
    s: Session,
    indent = 0,
    status?: RecentChain["status"],
  ) => (
    <SidebarRow
      key={s.id}
      session={s}
      indent={indent}
      active={s.id === activeId}
      preview={s.id === previewId}
      running={isRunning(s.id)}
      unread={unreadIds.has(s.id)}
      status={status}
      location={SIDEBAR_V2 && layout === "time" ? sessionLocation(s, projects) : undefined}
      herdr={SIDEBAR_V2 && sidebarSource(s) === "herdr" ? herdrStatus.get(s.id) ?? { status: "unknown", alive: false, paneId: "" } : undefined}
      live={liveSessionIds.has(s.id)}
      editing={editingId === s.id}
      onPreview={() => { setMobileNavOpen(false); void previewSession(s.id); }}
      onPin={() => pinSession(s.id)}
      onStartEdit={() => setEditingId(s.id)}
      onCancelEdit={() => setEditingId(null)}
      onCommit={async (next) => {
        setEditingId(null);
        if (next.trim() && next.trim() !== s.title) {
          await renameSession(s.id, next);
        }
      }}
      onArchive={() => s.archived ? unarchiveSession(s.id) : archiveSession(s.id)}
      onDelete={() => {
        if (confirm("永久删除这个对话？\n（节点不可恢复）")) {
          deleteSession(s.id);
        }
      }}
    />
  );

  // Chat 也可折叠。用合成 id 走 projects 那套同一个 collapsed 集合，
  // 复用扁平分组状态。
  const renderGroup = (id: string, label: string, list: Session[]) => {
    if (list.length === 0) return null;
    const isCollapsed = collapsed.has(id);
    return (
      <div className="mb-3">
        <GroupRow
          level={0}
          collapsed={isCollapsed}
          label={label}
          title={`${label} · ${list.length} 个会话`}
          badge={isCollapsed ? String(list.length) : null}
          onToggle={() => toggleCollapsed(id)}
        />
        {!isCollapsed && (
          <IndentGuide level={0}>{list.map((s) => renderRow(s, 1))}</IndentGuide>
        )}
      </div>
    );
  };

  // S133：「最近」分组。会话行复用 SidebarRow（预览 / 固定 / 运行态 / 未读全部
  // 同款），下面挂链行：一条链 = 根→叶子 lineage，点链跨会话直接落到链尾 ——
  // 上次问到哪就回到哪。多树会话的链行带树名前缀；单树会话的树名就是会话
  // 标题的另一种说法，不重复。默认每会话只露前几条链，其余点开。
  const renderRecentGroup = () => {
    if (recent.length === 0) return null;
    const isCollapsed = collapsed.has("__recent");
    const sessionById = new Map(
      sessions.map((s) => [s.id, s]),
    );
    const toggleExpanded = (id: string) =>
      setRecentExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    return (
      <div className="mb-3">
        <GroupRow
          level={0}
          collapsed={isCollapsed}
          label="🕘 最近"
          title={`最近 · ${recent.length} 个会话\n按最后活动（写过或读过）排序；每个会话下列出最近的几条链，点链直接落到链尾`}
          badge={isCollapsed ? String(recent.length) : null}
          onToggle={() => toggleCollapsed("__recent")}
        />
        {!isCollapsed && (
          <IndentGuide level={0}>
            {recent.map((r) => {
              // 主列表里的会话对象优先（origin / cliProvider 等角标齐全）；两路
              // fetch 有先后，落空时用最近分组自带的骨架顶一下。
              const s = sessionById.get(r.id) ?? recentAsSession(r);
              const expanded = recentExpanded.has(r.id);
              const orderedChains = orderRecentChains(
                r.chains,
                runningNodeIds,
                waitingNodeIds,
              );
              const status = recentSessionStatus(
                orderedChains,
                runningNodeIds,
                waitingNodeIds,
                {
                  running: isRunning(r.id),
                  unread: unreadIds.has(r.id),
                },
              );
              const shown = expanded
                ? orderedChains
                : orderedChains.slice(0, RECENT_CHAINS_SHOWN);
              const folded = orderedChains.length - shown.length;
              return (
                <div key={r.id}>
                  {renderRow(s, 1, status)}
                  {shown.map((c) => (
                    <ChainRow
                      key={c.tipId}
                      chain={c}
                      status={deriveRecentChainStatus(
                        c,
                        runningNodeIds,
                        waitingNodeIds,
                      )}
                      showTree={r.treeCount > 1}
                      active={r.id === activeId && c.tipId === activeNodeId}
                      onOpen={() => {
                        setEditingId(null);
                        // 抽屉是覆盖层；同会话内换链 activeId 不变，那个
                        // effect 不会替我们收。
                        if (mobileNavOpen) setViewMode("linear");
                        setMobileNavOpen(false);
                        void openNodeInSession(r.id, c.tipId).catch(() => {
                          /* 会话已被删等：下次刷新这行自然消失 */
                        });
                      }}
                    />
                  ))}
                  {(folded > 0 || r.moreChains > 0) && (
                    <button
                      type="button"
                      onClick={() => toggleExpanded(r.id)}
                      style={{ paddingLeft: PAD(2) + 14, height: 22 }}
                      className="mx-1 flex items-center text-nano text-ink-faint hover:text-ink"
                      title={
                        r.moreChains > 0
                          ? `另有 ${r.moreChains} 条更早的链没列出 —— 进会话后在${STRUCTURE_PANEL ? "结构" : "树面板"}里找`
                          : undefined
                      }
                    >
                      {expanded ? "收起" : `还有 ${folded + r.moreChains} 条链`}
                    </button>
                  )}
                </div>
              );
            })}
          </IndentGuide>
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
          collapsed={wCollapsed}
          label={w.name}
          // 有 session 才可折叠；空的没有子内容，给三角就是个骗人的开关。
          toggleable={list.length > 0}
          tag={w.kind === "worktree" && !br ? "detached" : null}
          git={g ?? null}
          muted={list.length === 0 || isReclaimable}
          title={`${w.path}${(() => {
            return [
              br ? `\n分支: ${br}` : "",
              w.kind === "worktree" && !br
                ? "\nDetached HEAD：当前 worktree 没有检出命名分支"
                : "",
              g?.dirty ? `\n${g.dirty} 个文件有改动或未跟踪 (点击角标查看 Diff)` : "",
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
      if (SIDEBAR_V2 && source !== "all" && pCount === 0) return null;
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
        if (SIDEBAR_V2 && emptyWorkspaces.includes(w)) continue;
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
        <div key={p.id} data-sidebar-project={p.id} className="mb-3">
          <GroupRow
            level={0}
            collapsed={pCollapsed}
            label={SIDEBAR_V2 ? `${presentation.icon}${presentation.icon ? " " : ""}${presentation.name}` : p.name}
            title={`${SIDEBAR_V2 ? presentation.description : p.name}${p.gitRemote ? `\n${p.gitRemote}` : ""}\n${
              flat && p.workspaces.length === 1
                ? `${p.workspaces[0].path}\n`
                : `${p.workspaces.length} 个工作区 (${activeWorkspaces.length} 活跃 · ${reclaimableWorkspaces.length} 已合并) · `
            }${pCount} 个会话`}
            badge={pCollapsed && pCount > 0 ? String(pCount) : null}
            onToggle={() => toggleCollapsed(p.id)}
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
            <div className="mx-1 mb-1 pl-4 pr-2 py-1.5 rounded-md bg-surface-muted">
              <input
                autoFocus
                value={wtBranch}
                onChange={(e) => setWtBranch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createWorktree(p.id);
                  if (e.key === "Escape") setWtFor(null);
                }}
                placeholder="分支名（回车创建 · Esc 取消）"
                className="w-full px-1.5 py-1 rounded text-ui bg-surface border border-line-strong outline-none focus:border-accent text-ink-strong"
              />
              <div className="mt-1 text-nano text-ink-faint">
                {wtBusy
                  ? "创建中…"
                  : wtError
                    ? <span className="text-danger">{wtError}</span>
                    : "已有同名分支则直接检出，否则新建；目录落在主 checkout 的同级"}
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
                    label="✓ 已合并"
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
          {SIDEBAR_V2 && !pCollapsed && emptyWorkspaces.length > 0 && (
            <IndentGuide level={0}>
              <GroupRow level={1} collapsed={!emptyOpen} label={`其它 ${emptyWorkspaces.length} 个工作区`} title="这些工作区没有符合当前筛选的会话；展开可新建会话、查看分支和清理已合并工作区" badge={null} muted onToggle={() => toggleCollapsed(emptyKey)} />
              {emptyOpen && emptyWorkspaces.map(w => renderWorkspaceItem(w, Boolean(gitStatus.get(w.id)?.reclaimable)))}
            </IndentGuide>
          )}
        </div>
      );
    });

  // The panel body (new-session + grouped list + archived footer) is shared by
  // the desktop rail and the mobile drawer. `onClose` wires the header chevron
  // to whichever container is showing it (collapse rail vs close drawer).
  const renderPanel = (onClose: () => void) => (
    <>
      {/* Header: new-session entry (R2) + collapse/close toggle. */}
      <div className="shrink-0 px-2 pt-2 pb-1.5 border-b border-line-faint flex items-center gap-1.5">
        <Button
          variant="primary"
          size="sm"
          data-mobile-target="drawer-new-session"
          onClick={onNew}
          title="新会话：开一棵全新树（与「🧹 新话题」不同——后者在当前会话内清空上下文）"
          className="flex-1 h-8"
        >
          <span aria-hidden className="text-base leading-none">＋</span>
          新会话
        </Button>
        <IconButton
          label="收起"
          data-mobile-target="drawer-close"
          onClick={onClose}
          className="w-7 h-8"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
            <path d="M7.5 2 L3.5 6 L7.5 10" />
          </svg>
        </IconButton>
      </div>

      {/* CLI 同步：attach 本机 Claude Code / Codex 会话（双向）。 */}
      <button
        onClick={() => setAttachOpen(true)}
        data-mobile-target="drawer-attach"
        title="把本机 Claude Code / Codex CLI 会话 attach 进来（双向同步）"
        className="hidden md:inline-flex shrink-0 mx-2 mt-1.5 items-center justify-center gap-1.5 h-7 rounded-md border border-dashed border-line-strong text-label text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors"
      >
        <span aria-hidden>⇄</span>
        Attach CLI 会话
      </button>

      <div className="md:hidden shrink-0 mx-2 mt-1.5">
        <button
          type="button"
          data-mobile-target="drawer-advanced"
          aria-expanded={mobileAdvancedOpen}
          onClick={() => setMobileAdvancedOpen((open) => !open)}
          className="w-full min-h-11 px-3 rounded-md text-label text-ink-faint flex items-center justify-between hover:bg-surface-muted"
        >
          <span>高级操作</span>
          <span aria-hidden>{mobileAdvancedOpen ? "▾" : "▸"}</span>
        </button>
        {mobileAdvancedOpen && (
          <button
            type="button"
            onClick={() => setAttachOpen(true)}
            data-mobile-target="drawer-attach"
            title="把本机 Claude Code / Codex CLI 会话 attach 进来（双向同步）"
            className="mt-1 w-full min-h-11 inline-flex items-center justify-center gap-1.5 rounded-md border border-dashed border-line-strong text-label text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors"
          >
            <span aria-hidden>⇄</span>
            Attach CLI 会话
          </button>
        )}
      </div>

      {SIDEBAR_V2 && (
        <div data-sidebar-toolbar className="shrink-0 border-b border-line-faint p-2 space-y-1 text-label">
          <div role="group" aria-label="会话排布" className="flex rounded-md border border-line bg-surface p-0.5">
            {([["project", "按项目"], ["time", "按时间"]] as const).map(([value, label]) => (
              <button key={value} type="button" aria-pressed={layout === value} onClick={() => setLayout(value)} className={`flex-1 rounded px-2 h-7 max-md:h-11 ${layout === value ? "bg-accent-muted text-accent-ink font-semibold" : "text-ink-faint hover:text-ink"}`}>{label}</button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 min-w-0">
            <label className="flex items-center gap-1 min-w-[5.5rem] flex-1 text-ink-muted">来源
              <select aria-label="来源" value={source} onChange={e => setSource(e.target.value as SidebarSource)} className="min-w-0 flex-1 h-7 max-md:h-11 rounded bg-surface text-ink border border-line">
                <option value="all">全部</option><option value="web">网页</option><option value="herdr">Herdr</option><option value="task">任务</option><option value="lark">飞书</option><option value="external">外部</option>
              </select>
            </label>
            <label className="flex items-center gap-1 h-7 max-md:h-11 text-ink-muted whitespace-nowrap cursor-pointer"><input type="checkbox" checked={includeArchived} onChange={e => setIncludeArchived(e.target.checked)} />含已归档</label>
          </div>
        </div>
      )}
      <div data-sidebar-list data-sidebar-layout={SIDEBAR_V2 ? layout : "legacy"} className="flex-1 overflow-y-auto py-1.5">
        {!SIDEBAR_V2 && <HerdrSidebarGroup
          GroupRow={GroupRow}
          collapsed={collapsed}
          onToggle={toggleCollapsed}
          activeSessionId={activeId}
          onOpenSession={(sessionId) => {
            setEditingId(null);
            setViewMode("linear");
            setMobileNavOpen(false);
            void previewSession(sessionId);
          }}
        />}
        {SIDEBAR_V2 && source === "herdr" && !herdrAvailable && <div data-herdr-unavailable className="mx-2 mb-2 rounded-md border border-line bg-surface px-3 py-2 text-label text-ink-muted">{unavailableText}<p className="mt-1 text-nano text-ink-faint">仍可阅读已同步的会话。启动 Herdr 后将自动恢复状态。</p></div>}
        {visibleSessions.length === 0 ? (
          <div className="px-3 py-3 text-label text-ink-faint italic">
            {SIDEBAR_V2 && source !== "all" ? "还没有此来源的会话，切换为「全部」查看其它会话" : "还没有会话，点上面「新会话」开始"}
          </div>
        ) : SIDEBAR_V2 && layout === "time" ? visibleSessions.map(s => renderRow(s)) : (
          <>
            {/* S133：最近活动的会话，粒度到链。 */}
            {!SIDEBAR_V2 && renderRecentGroup()}
            {renderProjects()}
            {renderGroup("__chat", SIDEBAR_V2 ? "速记（无工作区）" : "Chat", chat)}
          </>
        )}
      </div>

      {/* Archived view — moved here from SessionPicker (now removed from the
          tab strip). Expand to restore archived sessions. */}
      {!SIDEBAR_V2 && archivedCount > 0 && (
        <div className="shrink-0 border-t border-line-faint">
          <button
            onClick={() => setArchivedOpen((o) => !o)}
            className="w-full px-2 py-1.5 flex items-center gap-1.5 text-label text-ink-muted hover:bg-surface-muted"
          >
            <span aria-hidden className="text-nano">{archivedOpen ? "▾" : "▸"}</span>
            <span>🗄 已归档</span>
            <span className="ml-auto tabular-nums text-ink-faint">
              {archivedCount}
            </span>
          </button>
          {archivedOpen && (
            <div className="max-h-48 overflow-y-auto pb-1">
              {archived.length === 0 ? (
                <div className="px-3 py-2 text-label text-ink-faint italic">
                  加载中…
                </div>
              ) : (
                archived.map((s) => (
                  <div
                    key={s.id}
                    style={{ paddingLeft: PAD(0) }}
                    className={`${ROW_HEIGHT_CLASS} group mx-1 rounded-md flex items-center gap-1.5 pr-1 text-ink-muted hover:bg-surface-muted`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 opacity-50 ${modeStyle(s.mode).dot}`}
                      aria-hidden
                    />
                    <span className="flex-1 min-w-0 truncate text-ui" title={s.title}>
                      {s.title}
                    </span>
                    <IconButton
                      label="恢复"
                      title="恢复（取消归档）"
                      size="sm"
                      onClick={() => unarchiveSession(s.id)}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M3 7v6h6" />
                        <path d="M3 13a9 9 0 1 0 3-7.7L3 8" />
                      </svg>
                    </IconButton>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
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
          className="hidden md:flex fixed left-0 top-12 bottom-0 z-30 flex-col bg-surface-canvas/90 backdrop-blur border-r border-line"
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
      ) : (
        // Collapsed → thin re-open affordance so the rail can be brought back.
        <button
          onClick={() => setSidebarOpen(true)}
          title="展开侧栏"
          aria-label="展开侧栏"
          className="hidden md:flex fixed left-0 top-1/2 -translate-y-1/2 z-30 w-5 h-12 items-center justify-center rounded-r-md bg-surface/90 border border-l-0 border-line text-ink-faint hover:text-ink shadow-raise"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
            <path d="M4.5 2 L8.5 6 L4.5 10" />
          </svg>
        </button>
      )}

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
const ROW_HEIGHT_CLASS = "h-[26px] max-md:h-11";
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
 * workspace 行右侧的 git 角标：脏文件数 · 可回收。
 *
 * 点击脏文件角标可直接打开 Diff 变更检视抽屉。
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
    <span className={`shrink-0 flex items-center gap-1 text-nano ${SIDEBAR_V2 ? "" : "md:group-hover:hidden"}`}>
      {git.dirty > 0 && (
        <button
          type="button"
          onClick={(e) => {
            if (onInspectDiff) {
              e.stopPropagation();
              onInspectDiff();
            }
          }}
          title={`${git.dirty} 个文件有改动或未跟踪（点击查看改动详情）`}
          className={`tabular-nums text-warn font-medium px-1 py-0.5 rounded hover:bg-warn-muted transition-colors ${
            onInspectDiff ? "cursor-pointer" : ""
          }`}
        >
          ●{git.dirty}
        </button>
      )}
      {git.reclaimable && (
        <span className="text-positive font-semibold" title="已合并入主干且工作区干净">
          ✓
        </span>
      )}
    </span>
  );
}

function GroupRow({
  level,
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
  return (
    <div
      data-sidebar-group
      className={`${ROW_HEIGHT_CLASS} group relative mx-1 flex items-center gap-1 pr-1 rounded-md ${
        toggleable ? "hover:bg-surface-muted" : ""
      } ${muted ? "opacity-75" : ""}`}
    >
      <button
        onClick={toggleable ? onToggle : undefined}
        aria-expanded={toggleable ? !collapsed : undefined}
        title={title}
        style={{ paddingLeft: PAD(level) }}
        className={`flex-1 min-w-0 flex items-center gap-1 h-full text-left text-ui ${
          toggleable ? "" : "cursor-default"
        } ${
          level === 0
            ? "font-semibold text-ink-strong"
            : "font-medium text-ink"
        }`}
      >
        <span
          aria-hidden
          className={`w-2.5 shrink-0 text-nano text-ink-faint transition-transform ${
            collapsed ? "" : "rotate-90"
          } ${toggleable ? "" : "opacity-0"}`}
        >
          ▸
        </span>
        <span className="flex-1 min-w-0 truncate">{label}</span>
      </button>
      {/* tag / badge 让位给操作按钮，但只在真能 hover 的设备上 */}
      {tag && (
        <span className={`shrink-0 text-nano px-1 rounded bg-surface-muted text-ink-faint ${SIDEBAR_V2 ? "" : "group-hover:hidden"}`}>
          {tag}
        </span>
      )}
      {git && <GitBadge git={git} onInspectDiff={onInspectDiff} />}
      {badge && (
        <span className={`shrink-0 text-nano tabular-nums text-ink-faint ${!SIDEBAR_V2 && (onAdd || onInspectDiff || onBatchClean || onRemove) ? "group-hover:hidden" : ""}`}>
          {badge}
        </span>
      )}
      {(onAdd || onInspectDiff || onBatchClean || onRemove) && (
        <div className="shrink-0 hidden group-hover:flex pointer-coarse:flex items-center gap-0.5">
          {onInspectDiff && (
            <RowIconButton title={diffTitle} onClick={onInspectDiff}>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="9" y1="13" x2="15" y2="13" />
              <line x1="9" y1="17" x2="15" y2="17" />
            </RowIconButton>
          )}
          {onBatchClean && (
            <RowIconButton title={batchCleanTitle} onClick={onBatchClean}>
              <path d="M19 11l-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11z" />
              <path d="M5 21h14" />
            </RowIconButton>
          )}
          {onAdd && (
            <RowIconButton title={addTitle} onClick={onAdd}>
              <path d="M12 5v14M5 12h14" />
            </RowIconButton>
          )}
          {onRemove && (
            <RowIconButton
              title={removeTitle}
              danger
              onClick={onRemove}
            >
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
            </RowIconButton>
          )}
        </div>
      )}
    </div>
  );
}

function SidebarRow({
  session,
  indent = 0,
  active,
  preview,
  running,
  unread,
  status,
  location,
  herdr,
  live,
  editing,
  onPreview,
  onPin,
  onStartEdit,
  onCancelEdit,
  onCommit,
  onArchive,
  onDelete,
}: {
  session: Session;
  /** 缩进层级：1 = 挂在 Chat / 暂存区下，2 = 挂在 Project → Workspace 下 */
  indent?: number;
  active: boolean;
  preview: boolean;
  running: boolean;
  unread: boolean;
  /** 最近分组传入整会话链聚合；其他分组缺省时维持原 running/unread 语义。 */
  status?: RecentChain["status"];
  location?: string;
  herdr?: HerdrSessionStatus;
  live: boolean;
  editing: boolean;
  onPreview: () => void;
  onPin: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onCommit: (title: string) => void | Promise<void>;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const style = modeStyle(session.mode);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(session.title);
  const sourceChip = sessionSourceChip(session) ?? (location ? { label: "网页", title: "网页会话（含手动接入的 CLI）" } : null);
  const indicatorStatus =
    status ?? (herdr?.alive && (herdr.status === "waiting" || herdr.status === "blocked") ? "waiting" : running || (herdr?.alive && herdr.status === "working") ? "streaming" : unread ? "unread" : "done");
  const statusTitle =
    indicatorStatus === "waiting"
      ? "等你回答"
      : indicatorStatus === "streaming"
        ? "生成中…"
        : indicatorStatus === "error"
          ? "出错"
          : indicatorStatus === "unread"
            ? "完成·未读"
            : "";

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

  return (
    <div
      style={{ paddingLeft: PAD(indent) }}
      data-mobile-target="session-row"
      data-session-id={session.id}
      data-session-source={sidebarSource(session)}
      data-session-archived={session.archived || undefined}
      data-herdr-pane={herdr?.paneId || undefined}
      data-herdr-status={herdr ? herdr.alive ? herdr.status : "offline" : undefined}
      className={`${location ? "h-11" : ROW_HEIGHT_CLASS} ${session.archived ? "opacity-55" : ""} group relative mx-1 rounded-md flex items-center gap-1.5 pr-1 cursor-pointer transition-colors overflow-hidden ${
        indicatorStatus === "waiting" || indicatorStatus === "streaming"
          ? // Running tint (accent) + left accent bar (added below). Overrides
            // mode/active bg so "in progress" rows are unmistakable.
            "bg-accent-muted text-accent-ink font-medium"
          : indicatorStatus === "error"
            ? "bg-danger-muted text-danger-ink font-medium"
            : indicatorStatus === "unread"
              ? // Finished-unread tint (unread hue), loud but static.
                "bg-unread-muted text-unread-ink font-medium"
              : active
                ? `${style.activeBg} ${style.text} font-medium`
                : "text-ink-muted hover:bg-surface-muted"
      }`}
      onClick={editing ? undefined : onPreview}
      onDoubleClick={editing ? undefined : onPin}
      title={`${style.label} · ${session.title}${statusTitle ? `\n${statusTitle}` : ""}\n单击预览 · 双击固定`}
    >
      {/* Left accent bar for the running row (solid accent; the spinner +
          「生成中」 carry the motion). */}
      {(indicatorStatus === "waiting" || indicatorStatus === "streaming") && (
        <span
          className="absolute left-0 top-0 bottom-0 w-[3px] bg-accent"
          aria-hidden
        />
      )}
      {/* Leading indicator: spinner while running, else the mode color dot. */}
      {indicatorStatus === "waiting" ? (
        <span
          className="shrink-0 text-[10px] animate-pulse"
          aria-label="等你回答"
        >
          🙋
        </span>
      ) : indicatorStatus === "streaming" ? (
        <Dots />
      ) : indicatorStatus === "error" ? (
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0 bg-danger"
          aria-label="出错"
        />
      ) : (
        // 6px + 半透明，而非原来 8px 满色：一栏几十行、每行一个饱和色点，
        // 点会盖过标题成为最强视觉元素，把层次压平。它只编码 mode（二值），
        // 不值这个权重 —— 降到「余光可辨、不抢焦点」即可。
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 opacity-55 ${style.dot}`}
          aria-hidden
        />
      )}

      {editing ? (
        <input
          ref={inputRef}
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
          className="flex-1 min-w-0 px-1 py-0.5 rounded text-ui bg-surface border border-line-strong outline-none focus:border-accent text-ink-strong"
        />
      ) : (
        <span
          className={`flex-1 min-w-0 truncate text-ui ${
            // Preview (non-pinned, transient) tabs read italic, like VSCode.
            preview && !active ? "italic text-ink-muted" : ""
          } ${preview ? "italic" : ""}`}
        >
          {session.title}
          {location && <span className="block truncate text-nano text-ink-faint font-normal not-italic" title={location}>{location}</span>}
        </span>
      )}

      {sourceChip && !editing && (
        <span
          className="shrink-0 text-nano font-semibold px-1 py-px rounded bg-surface-muted text-ink-muted"
          title={sourceChip.title}
          aria-label={sourceChip.title}
        >
          {sourceChip.label}
        </span>
      )}
      {herdr && !editing && <span data-herdr-alive={herdr.alive} title={herdr.alive ? `Herdr 在线 · ${herdr.status}` : "Herdr 离线 · 可阅读历史"} aria-label={herdr.alive ? "Herdr 在线" : "Herdr 离线"} className={`w-1.5 h-1.5 shrink-0 rounded-full ${herdr.alive ? herdr.status === "waiting" || herdr.status === "blocked" ? "bg-warn" : "bg-positive" : "bg-line-strong"}`} />}
      {SIDEBAR_V2 && !editing && (session.treeCount ?? 0) > 1 && <span title={`${session.treeCount} 个话题，进入会话后在${STRUCTURE_PANEL ? "结构" : "思维树"}切换`} className="shrink-0 text-nano text-ink-faint tabular-nums">{session.treeCount} 话题</span>}
      {session.archived && !editing && <span className="shrink-0 text-nano rounded bg-surface-muted px-1 text-ink-faint">归档</span>}

      {/* CLI 同步：attach 的会话标来源角标（双向绑定）。正被 CLI 实时驱动时
          换成「● live」脉冲（remote-control 式感知）。 */}
      {session.origin === "cli-import" && !editing && (
        live ? (
          <span
            className={`shrink-0 inline-flex items-center gap-1 text-nano font-semibold px-1 py-px rounded bg-positive text-ink-inverse ${SIDEBAR_V2 ? "" : "group-hover:hidden"}`}
            title={`正被一个活的 ${session.cliProvider === "codex" ? "Codex" : "Claude"} 进程实时驱动`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-ink-inverse animate-pulse" />
            live
          </span>
        ) : (
          <span
            className={`shrink-0 text-nano font-semibold px-1 py-px rounded bg-positive-muted text-positive-ink ${SIDEBAR_V2 ? "" : "group-hover:hidden"}`}
            title="已 attach 的本机 CLI 会话（双向同步）"
          >
            {session.cliProvider === "codex" ? "CX" : "CC"}
          </span>
        )
      )}

      {/* Running label — the sidebar row is wide enough to spell it out. */}
      {(indicatorStatus === "waiting" || indicatorStatus === "streaming") &&
        !editing && (
          <span className={`shrink-0 text-nano font-medium text-accent-ink ${SIDEBAR_V2 ? "" : "group-hover:hidden"}`}>
            {indicatorStatus === "waiting" ? "等你回答" : "生成中"}
          </span>
        )}

      {/* R3: finished-while-away unread — louder than the old small dot:
          unread-hue 「✓ 新」 pill. Distinct from the accent running state;
          hidden once running again or while hovering (actions take over). */}
      {indicatorStatus === "unread" && !editing && (
        <span
          className={`shrink-0 inline-flex items-center gap-0.5 pl-1 pr-1.5 h-4 rounded-full bg-unread text-ink-inverse text-nano font-semibold leading-none ring-1 ring-unread-line ${SIDEBAR_V2 ? "" : "group-hover:hidden"}`}
          title="完成·未读"
          aria-label="完成·未读"
        >
          <svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M2.5 6.5 L5 9 L9.5 3.5" />
          </svg>
          新
        </span>
      )}

      {/* Hover actions: rename / archive / delete (replaces SessionPicker
          per-row management; group-hover reveals, hidden while editing). */}
      {!editing && (
        <div className="shrink-0 hidden group-hover:flex items-center gap-0.5 bg-inherit">
          <RowIconButton title="重命名" onClick={onStartEdit}>
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </RowIconButton>
          <RowIconButton title={session.archived ? "恢复（取消归档）" : "归档（收起，可恢复）"} onClick={onArchive}>
            <rect x="3" y="4" width="18" height="4" rx="1" />
            <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
            <path d="M10 12h4" />
          </RowIconButton>
          <RowIconButton title="删除" danger onClick={onDelete}>
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6M14 11v6" />
            <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
          </RowIconButton>
        </div>
      )}
    </div>
  );
}

// 最近分组自带的会话骨架 → Session（主列表还没回来时顶一下）。只填 SidebarRow
// 会读的字段；origin / cliProvider 缺省即无角标，主列表到位后自然补齐。
function recentAsSession(r: RecentSession): Session {
  return {
    id: r.id,
    title: r.title,
    rootNodeId: "",
    createdAt: r.activityAt,
    updatedAt: r.activityAt,
    mode: r.mode,
    workspacePath: r.workspacePath,
    systemPrompt: null,
    archived: false,
    model: null,
  };
}

// S133：最近分组的链行，挂在会话行下一级：「↳ [树名 › ]链尾标签 · 时间」。
// 状态编码整条 lineage，紧急度降序：等输入 🙋 > 生成中 > 出错 > 未读点 ——
// 与树面板树行的 rollup 同一套读法，看惯了那边的这边不用再学。
function ChainRow({
  chain,
  status,
  showTree,
  active,
  onOpen,
}: {
  chain: RecentChain;
  status: RecentChain["status"];
  showTree: boolean;
  active: boolean;
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
  return (
    <button
      type="button"
      data-mobile-target="session-chain-row"
      onClick={onOpen}
      style={{ paddingLeft: PAD(2) }}
      // button 的 display:flex 只让它成为 flex 容器，宽度仍按内容算（不像 div
      // 会撑满）；不显式给宽，长标签就不 truncate、时间被挤出侧栏右缘。
      className={`${ROW_HEIGHT_CLASS} mx-1 w-[calc(100%-0.5rem)] rounded-md flex items-center gap-1.5 pr-1.5 text-left transition-colors ${
        active
          ? "bg-surface-muted text-ink font-medium"
          : "text-ink-muted hover:bg-surface-muted"
      }`}
      title={`${withTree ? `${chain.treeLabel} › ` : ""}${chain.label}\n${chain.depth} 轮${statusNote} · ${time}\n点击落到这条链的链尾`}
    >
      <span aria-hidden className="shrink-0 text-nano text-ink-faint">
        ↳
      </span>
      {status === "waiting" ? (
        <span className="shrink-0 text-[10px] animate-pulse" aria-label="等你回答">
          🙋
        </span>
      ) : status === "streaming" ? (
        <Dots />
      ) : status === "error" ? (
        <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-danger" aria-label="出错" />
      ) : status === "unread" ? (
        <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-unread" aria-label="未读" />
      ) : null}
      <span className="flex-1 min-w-0 truncate text-ui">
        {withTree && (
          <span className="text-ink-faint">{chain.treeLabel} › </span>
        )}
        {chain.label}
      </span>
      <span className="shrink-0 text-nano tabular-nums text-ink-faint">
        {time}
      </span>
    </button>
  );
}

function RowIconButton({
  title,
  danger,
  onClick,
  children,
}: {
  title: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      title={title}
      aria-label={title}
      className={`p-1 rounded text-ink-muted ${
        danger
          ? "hover:bg-danger-muted hover:text-danger"
          : "hover:bg-surface-muted hover:text-ink-strong"
      }`}
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {children}
      </svg>
    </button>
  );
}
