"use client";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { useIsMobile } from "@/hooks/useIsMobile";
import type { ProjectSummary, Session } from "@/lib/types";

// S1：折叠状态。per-project / per-workspace id 存一个集合，localStorage
// 持久化（sendKey / treePanelView 同款）。默认全展开 —— 项目数是个位数，
// 一进来就得手动展开才能看见东西是更差的默认。
const COLLAPSE_KEY = "trellis-sidebar-collapsed";

function loadCollapsed(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(COLLAPSE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

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
  const unreadIds = useSessionStore((s) => s.unreadSessionIds);
  const unarchiveSession = useSessionStore((s) => s.unarchiveSession);
  const bumpSessionsRevision = useSessionStore((s) => s.bumpSessionsRevision);
  const liveSessionIds = useSessionStore((s) => s.liveSessionIds);
  const [attachOpen, setAttachOpen] = useState(false);
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
  // 惰性初值直接读 localStorage（store 里 loadSidebarOpen 同款），不走 effect。
  // 不会 hydration 不匹配：projects 初值是 []、靠 fetch 填，首屏一个分组行都不
  // 渲染，折叠状态在 fetch 回来之前根本不可见。
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [width, setWidth] = useState<number>(loadSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const isMobile = useIsMobile();

  // 侧栏自己拥有宽度，就由它来发布 --trellis-sb（原先在 page.tsx 里按常量发，
  // 宽度一旦可拖拽，两处就会打架）。所有消费者读的仍是同一个变量，不用改。
  useEffect(() => {
    const offset = !isMobile && sidebarOpen ? width : 0;
    document.documentElement.style.setProperty("--trellis-sb", `${offset}px`);
  }, [isMobile, sidebarOpen, width]);

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
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
      } catch {
        /* 隐私模式下写不进去，折叠状态退化成只在本次会话内有效 */
      }
      return next;
    });
  };
  // Archived view (replaces SessionPicker's "显示已归档" toggle). Count comes
  // free from the main list response; the archived rows are fetched lazily
  // only when the footer is expanded.
  const [archivedCount, setArchivedCount] = useState(0);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archived, setArchived] = useState<Session[]>([]);

  // Same watch contract as SessionPicker / SessionTabs: refetch on active
  // change or any store mutation that bumps sessionsRevision.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/sessions")
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
  }, [activeId, sessionsRevision]);

  // Lazy-load archived rows only while the footer is open. Re-runs on any
  // mutation (sessionsRevision) so unarchiving instantly removes the row.
  useEffect(() => {
    if (!archivedOpen) return;
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
  }, [archivedOpen, sessionsRevision]);

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
    for (const s of sessions) {
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
  }, [sessions, projects]);

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
    } catch {
      setWtError("网络错误");
    } finally {
      setWtBusy(false);
    }
  };

  const removeWorktree = async (w: { id: string; name: string }) => {
    const r = await fetch(`/api/workspaces/worktree?workspaceId=${w.id}`, {
      method: "DELETE",
    }).then((x) => x.json());
    if (r.dirty) {
      if (
        !confirm(
          `「${w.name}」有未提交的改动：\n\n${r.dirty.join("\n")}\n\n仍要删除？（改动会丢失，不可恢复）`,
        )
      )
        return;
      await fetch(`/api/workspaces/worktree?workspaceId=${w.id}&force=1`, {
        method: "DELETE",
      });
    } else if (r.error) {
      alert(`删除失败：${r.error}`);
      return;
    }
    bumpSessionsRevision();
  };

  const onNew = () => {
    newConversation();
    setEditingId(null);
  };

  // 单行渲染。indent 让它能在 Chat（平铺）与 Project→Workspace（缩两级）
  // 两种上下文里复用同一个组件，缩进不进 SidebarRow 内部。
  const renderRow = (s: Session, indent = 0) => (
    <SidebarRow
      key={s.id}
      session={s}
      indent={indent}
      active={s.id === activeId}
      preview={s.id === previewId}
      running={isRunning(s.id)}
      unread={unreadIds.has(s.id)}
      live={liveSessionIds.has(s.id)}
      editing={editingId === s.id}
      onPreview={() => previewSession(s.id)}
      onPin={() => pinSession(s.id)}
      onStartEdit={() => setEditingId(s.id)}
      onCancelEdit={() => setEditingId(null)}
      onCommit={async (next) => {
        setEditingId(null);
        if (next.trim() && next.trim() !== s.title) {
          await renameSession(s.id, next);
        }
      }}
      onArchive={() => archiveSession(s.id)}
      onDelete={() => {
        if (confirm("永久删除这个对话？\n（节点不可恢复）")) {
          deleteSession(s.id);
        }
      }}
    />
  );

  // Chat 与「未归组」也可折叠。用合成 id 走 projects 那套同一个 collapsed 集合，
  // 免得为两个扁平分组再开一份状态。
  const renderGroup = (id: string, label: string, list: Session[]) => {
    if (list.length === 0) return null;
    const isCollapsed = collapsed.has(id);
    return (
      <div className="mb-1.5">
        <GroupRow
          level={0}
          collapsed={isCollapsed}
          label={label}
          title={`${label} · ${list.length} 个会话`}
          badge={isCollapsed ? String(list.length) : null}
          onToggle={() => toggleCollapsed(id)}
        />
        {!isCollapsed && list.map((s) => renderRow(s, 1))}
      </div>
    );
  };

  // S1 三级：Project → Workspace → Session。折叠子树时把「藏了几个会话」
  // 回显出来（与树面板折叠行同语义 —— 折叠不该把状态一起藏掉）。
  const renderProjects = () =>
    projects.map((p) => {
      const pCollapsed = collapsed.has(p.id);
      const pCount = p.workspaces.reduce(
        (n, w) => n + (byWorkspace.get(w.id)?.length ?? 0),
        0,
      );
      return (
        <div key={p.id} className="mb-1.5">
          <GroupRow
            level={0}
            collapsed={pCollapsed}
            label={p.name}
            title={`${p.name}${p.gitRemote ? `\n${p.gitRemote}` : ""}\n${p.workspaces.length} 个工作区 · ${pCount} 个会话`}
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
          {!pCollapsed &&
            p.workspaces.map((w) => {
              const list = byWorkspace.get(w.id) ?? [];
              const wCollapsed = collapsed.has(w.id);
              return (
                <div key={w.id}>
                  <GroupRow
                    level={1}
                    collapsed={wCollapsed}
                    label={w.name}
                    // 有 session 才可折叠；空的（worktree 扫出来还没用过）
                    // 没有子内容，给三角就是个骗人的开关。
                    toggleable={list.length > 0}
                    tag={w.kind === "worktree" ? "worktree" : null}
                    muted={list.length === 0}
                    title={`${w.path}${w.gitBranch ? `\n分支 ${w.gitBranch}` : ""}\n${list.length} 个会话${list.length === 0 ? "（还没在这里开过会话）" : ""}`}
                    badge={
                      wCollapsed && list.length > 0 ? String(list.length) : null
                    }
                    onToggle={() => toggleCollapsed(w.id)}
                    // 只有 trellis 自己 worktree add 出来的才允许从 UI 删磁盘；
                    // 发现来的（用户在 CLI 里建的）不给这个按钮。
                    onRemove={
                      w.createdBy === "trellis" && w.kind === "worktree"
                        ? () => void removeWorktree(w)
                        : undefined
                    }
                  />
                  {!wCollapsed && list.map((s) => renderRow(s, 2))}
                </div>
              );
            })}
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
          onClick={onNew}
          title="新会话：开一棵全新树（与「🧹 新话题」不同——后者在当前会话内清空上下文）"
          className="flex-1 h-8"
        >
          <span aria-hidden className="text-base leading-none">＋</span>
          新会话
        </Button>
        <IconButton
          label="收起"
          onClick={onClose}
          className="w-7 h-8"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
            <path d="M7.5 2 L3.5 6 L7.5 10" />
          </svg>
        </IconButton>
      </div>

      {/* CLI 同步：attach 本机 Claude Code 会话（双向）。 */}
      <button
        onClick={() => setAttachOpen(true)}
        title="把本机 Claude Code CLI 会话 attach 进来（双向同步）"
        className="shrink-0 mx-2 mt-1.5 inline-flex items-center justify-center gap-1.5 h-7 rounded-md border border-dashed border-line-strong text-label text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors"
      >
        <span aria-hidden>⇄</span>
        Attach CLI 会话
      </button>

      <div className="flex-1 overflow-y-auto py-1.5">
        {sessions.length === 0 ? (
          <div className="px-3 py-3 text-label text-ink-faint italic">
            还没有会话，点上面「新会话」开始
          </div>
        ) : (
          <>
            {renderProjects()}
            {renderGroup("__chat", "Chat", chat)}
            {/* 归不了组的 project 会话：目录已被删，或存量行压根没记 cwd。
                单列一组而不是悄悄隐藏，否则用户会以为会话丢了。 */}
            {renderGroup("__orphans", "未归组", orphans)}
          </>
        )}
      </div>

      {/* Archived view — moved here from SessionPicker (now removed from the
          tab strip). Expand to restore archived sessions. */}
      {archivedCount > 0 && (
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
                    className="group mx-1 rounded-md flex items-center gap-1.5 pl-2 pr-1 h-7 text-ink-muted hover:bg-surface-muted"
                  >
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 opacity-50 ${modeStyle(s.mode).dot}`}
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
    </>
  );
}

// S1：Project / Workspace 的分组行。两级共用一个组件，靠 level 调缩进与字重
// —— 项目行是这棵树的骨架（强），工作区行是它的分支（弱）。
//
// 外层刻意是 div 而非 button：行上要挂「+ 新建 worktree」「删除」这类操作，
// button 里套 button 是非法 HTML（SidebarRow 同款处理）。
function GroupRow({
  level,
  collapsed,
  label,
  title,
  badge,
  tag,
  muted,
  toggleable = true,
  onToggle,
  onAdd,
  onRemove,
}: {
  level: 0 | 1;
  collapsed: boolean;
  label: string;
  title: string;
  badge: string | null;
  tag?: string | null;
  muted?: boolean;
  toggleable?: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div
      className={`group flex items-center gap-1 pr-1 h-6 rounded-md ${
        toggleable ? "hover:bg-surface-muted" : ""
      } ${muted ? "opacity-60" : ""}`}
    >
      <button
        onClick={toggleable ? onToggle : undefined}
        title={title}
        className={`flex-1 min-w-0 flex items-center gap-1 h-6 text-left ${
          toggleable ? "" : "cursor-default"
        } ${
          level === 0
            ? "pl-1.5 text-ui font-medium text-ink-strong"
            : "pl-4 text-label text-ink-muted"
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
      {tag && (
        <span className="shrink-0 text-nano px-1 rounded bg-surface-muted text-ink-faint group-hover:hidden">
          {tag}
        </span>
      )}
      {badge && (
        <span className="shrink-0 text-nano tabular-nums text-ink-faint group-hover:hidden">
          {badge}
        </span>
      )}
      {(onAdd || onRemove) && (
        <div className="shrink-0 hidden group-hover:flex items-center gap-0.5">
          {onAdd && (
            <RowIconButton title="在这个项目下新建 worktree" onClick={onAdd}>
              <path d="M12 5v14M5 12h14" />
            </RowIconButton>
          )}
          {onRemove && (
            <RowIconButton title="删除这个 worktree（未提交改动会先拦一次）" danger onClick={onRemove}>
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
  /** 0 = 平铺（Chat / 未归组），2 = 挂在 Project → Workspace 下 */
  indent?: number;
  active: boolean;
  preview: boolean;
  running: boolean;
  unread: boolean;
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
      style={indent ? { marginLeft: 4 + indent * 8 } : undefined}
      className={`group relative mx-1 rounded-md flex items-center gap-1.5 pl-2 pr-1 h-7 cursor-pointer transition-colors overflow-hidden ${
        running
          ? // Running tint (accent) + left accent bar (added below). Overrides
            // mode/active bg so "in progress" rows are unmistakable.
            "bg-accent-muted text-accent-ink font-medium"
          : unread
            ? // Finished-unread tint (unread hue), loud but static.
              "bg-unread-muted text-unread-ink font-medium"
            : active
              ? `${style.activeBg} ${style.text} font-medium`
              : "text-ink-muted hover:bg-surface-muted"
      }`}
      onClick={editing ? undefined : onPreview}
      onDoubleClick={editing ? undefined : onPin}
      title={`${style.label} · ${session.title}${running ? "\n生成中…" : unread ? "\n完成·未读" : ""}\n单击预览 · 双击固定`}
    >
      {/* Left accent bar for the running row (solid accent; the spinner +
          「生成中」 carry the motion). */}
      {running && (
        <span
          className="absolute left-0 top-0 bottom-0 w-[3px] bg-accent"
          aria-hidden
        />
      )}
      {/* Leading indicator: spinner while running, else the mode color dot. */}
      {running ? (
        <Dots />
      ) : (
        <span className={`w-2 h-2 rounded-full shrink-0 ${style.dot}`} aria-hidden />
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
        </span>
      )}

      {/* CLI 同步：attach 的会话标个 CLI 角标（双向绑定）。正被 claude 实时驱动时
          换成「● live」脉冲（remote-control 式感知）。 */}
      {session.origin === "cli-import" && !editing && (
        live ? (
          <span
            className="shrink-0 inline-flex items-center gap-1 text-nano font-semibold px-1 py-px rounded bg-positive text-ink-inverse group-hover:hidden"
            title="正被一个活的 claude 进程实时驱动"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-ink-inverse animate-pulse" />
            live
          </span>
        ) : (
          <span
            className="shrink-0 text-nano font-semibold px-1 py-px rounded bg-positive-muted text-positive-ink group-hover:hidden"
            title="已 attach 的本机 CLI 会话（双向同步）"
          >
            CLI
          </span>
        )
      )}

      {/* Running label — the sidebar row is wide enough to spell it out. */}
      {running && !editing && (
        <span className="shrink-0 text-nano font-medium text-accent-ink group-hover:hidden">
          生成中
        </span>
      )}

      {/* R3: finished-while-away unread — louder than the old small dot:
          unread-hue 「✓ 新」 pill. Distinct from the accent running state;
          hidden once running again or while hovering (actions take over). */}
      {unread && !running && !editing && (
        <span
          className="shrink-0 inline-flex items-center gap-0.5 pl-1 pr-1.5 h-4 rounded-full bg-unread text-ink-inverse text-nano font-semibold leading-none ring-1 ring-unread-line group-hover:hidden"
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
          <RowIconButton title="归档（收起，可恢复）" onClick={onArchive}>
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
