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
import {
  HOME_CLUSTER_KEY,
  SCRATCH_CLUSTER_KEY,
  type ProjectSummary,
  type Session,
  type WorkspaceGitStatus,
} from "@/lib/types";

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
  const setDraftMode = useSessionStore((s) => s.setDraftMode);
  const setDraftWorkspacePath = useSessionStore((s) => s.setDraftWorkspacePath);
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
  useEffect(() => {
    const onFocus = () => setGitNonce((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

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

  // S1 三级：Project → Workspace → Session。折叠子树时把「藏了几个会话」
  // 回显出来（与树面板折叠行同语义 —— 折叠不该把状态一起藏掉）。
  //
  // 但三级不是恒定的：workspace 那一层**不带信息时就该消失**，否则它只是
  // 白占一级缩进、把真正要扫的会话往里推。两种不带信息的情形（见 isFlat）
  // 走两级渲染 —— Project → Session 直挂。
  const renderProjects = () =>
    projects.map((p) => {
      const pCollapsed = collapsed.has(p.id);
      const pCount = p.workspaces.reduce(
        (n, w) => n + (byWorkspace.get(w.id)?.length ?? 0),
        0,
      );
      // 平铺时各 workspace 的会话汇到一起，重新按最近活跃排 —— 每个 list
      // 内部有序不代表拼起来有序。
      const flatList = isFlat(p)
        ? p.workspaces
            .flatMap((w) => byWorkspace.get(w.id) ?? [])
            .sort((a, b) => b.updatedAt - a.updatedAt)
        : [];
      // 一个会话都没有就别平铺 —— 那会剩下个底下空无一物的项目行，
      // 还不如留着那条灰的 workspace 行说明「这里还没开过会话」。
      const flat = flatList.length > 0;
      return (
        <div key={p.id} className="mb-3">
          <GroupRow
            level={0}
            collapsed={pCollapsed}
            label={p.name}
            title={`${p.name}${p.gitRemote ? `\n${p.gitRemote}` : ""}\n${
              // 平铺掉 workspace 行后，路径没别处可看了 —— 挪进 project 的
              // tooltip，别让它随那一级一起消失。
              flat && p.workspaces.length === 1
                ? `${p.workspaces[0].path}\n`
                : `${p.workspaces.length} 个工作区 · `
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
            {p.workspaces.map((w) => {
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
                    // 有实时分支可显示时就不再挂「worktree」这个静态标签 ——
                    // 分支名信息量大得多，而一行里放不下两样。
                    tag={
                      w.kind === "worktree" && !gitStatus.get(w.id)?.branch
                        ? "worktree"
                        : null
                    }
                    git={gitStatus.get(w.id) ?? null}
                    muted={list.length === 0}
                    title={`${w.path}${(() => {
                      const g = gitStatus.get(w.id);
                      const br = g?.branch ?? w.gitBranch;
                      return [
                        br ? `\n分支 ${br}` : "",
                        g?.dirty ? `\n${g.dirty} 个文件有改动或未跟踪` : "",
                        g?.reclaimable ? "\n已并入主干且工作区干净 —— 可以回收" : "",
                      ].join("");
                    })()}\n${list.length} 个会话${list.length === 0 ? "（还没在这里开过会话）" : ""}`}
                    badge={
                      wCollapsed && list.length > 0 ? String(list.length) : null
                    }
                    onToggle={() => toggleCollapsed(w.id)}
                    // 「0 会话（还没在这里开过会话）」那行以前是条死路：看得见、
                    // 点不动、没有任何办法从它进到会话里。＋ 在这一级就是它的
                    // 出口，也是**已有** worktree（CLI 里建的、上次建完没用的）
                    // 唯一一个不用过 WorkspacePicker 的入口。
                    onAdd={() => startSessionIn(w.path)}
                    addTitle="在这个工作区下开新会话"
                    // 删磁盘只给 trellis 自己 worktree add 出来的 —— 用户在 CLI 里
                    // 建的该在 CLI 里删。至于「列表里留着已不存在的行」，由重扫的
                    // 自动 prune 解决，不需要一个手动的「移除」入口（实测过：
                    // 手动摘掉目录仍在的行，下次重扫就把它加回来了）。
                    onRemove={
                      w.createdBy === "trellis" && w.kind === "worktree"
                        ? () => void removeWorktree(w)
                        : undefined
                    }
                  />
                  {!wCollapsed && list.length > 0 && (
                    <IndentGuide level={1}>
                      {list.map((s) => renderRow(s, 2))}
                    </IndentGuide>
                  )}
                </div>
              );
            })}
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

      {/* CLI 同步：attach 本机 Claude Code / Codex 会话（双向）。 */}
      <button
        onClick={() => setAttachOpen(true)}
        title="把本机 Claude Code / Codex CLI 会话 attach 进来（双向同步）"
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
                    style={{ paddingLeft: PAD(0), height: ROW_H }}
                    className="group mx-1 rounded-md flex items-center gap-1.5 pr-1 text-ink-muted hover:bg-surface-muted"
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
const ROW_H = 26; // 三级统一行高；原先 group 24 / session 28 又是一处倒挂
const PAD = (level: number) => 6 + level * 12; // 内容缩进：6 / 18 / 30
const CHEVRON_MID = (level: number) => 4 /* mx-1 */ + PAD(level) + 5;

// 子树左侧的竖引导线，对齐父行三角的中心。文件树的标准读法：一眼看出
// 「这几行归谁管」，比单纯拉大缩进更省横向空间。
function IndentGuide({
  level,
  children,
}: {
  level: 0 | 1;
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
 * workspace 行右侧的 git 角标：分支 · 脏文件数 · 可回收。
 *
 * 这一行以前只有目录名和一个静态的「worktree」标签 —— 也就是说，三个并行
 * 工作区摆在一起，你看不出哪个有未提交的活、哪个已经可以清掉了。
 */
function GitBadge({
  git,
  label,
}: {
  git: WorkspaceGitStatus;
  label: string;
}) {
  // 分支名和目录名相同时不重复显示 —— worktree 通常同名，重复只是噪音。
  const branch = git.branch && git.branch !== label ? git.branch : null;
  if (!branch && !git.dirty && !git.reclaimable) return null;
  return (
    <span className="shrink-0 flex items-center gap-1 text-nano md:group-hover:hidden">
      {branch && (
        <span className="text-ink-faint truncate max-w-24">{branch}</span>
      )}
      {git.dirty > 0 && (
        <span className="text-warn tabular-nums">●{git.dirty}</span>
      )}
      {git.reclaimable && <span className="text-positive">✓</span>}
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
  onRemove,
}: {
  level: 0 | 1;
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
  onRemove?: () => void;
}) {
  return (
    <div
      className={`group relative mx-1 flex items-center gap-1 pr-1 rounded-md ${
        toggleable ? "hover:bg-surface-muted" : ""
      } ${muted ? "opacity-75" : ""}`}
      style={{ height: ROW_H }}
    >
      <button
        onClick={toggleable ? onToggle : undefined}
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
      {/* tag / badge 让位给操作按钮，但只在真能 hover 的设备上 ——
          Tailwind 的 group-hover 自带 `@media (hover:hover)` 包装，触屏上
          这条规则根本不匹配，于是那里三者共存。挤不下由 label 的 truncate
          吸收，这是可接受的降级。 */}
      {tag && (
        <span className="shrink-0 text-nano px-1 rounded bg-surface-muted text-ink-faint group-hover:hidden">
          {tag}
        </span>
      )}
      {git && <GitBadge git={git} label={label} />}
      {badge && (
        <span className="shrink-0 text-nano tabular-nums text-ink-faint group-hover:hidden">
          {badge}
        </span>
      )}
      {/* 判据是「有没有 hover 能力」，不是「屏幕多宽」。
          原来只有 `hidden group-hover:flex`，而移动端抽屉与桌面 rail 复用同一份
          renderPanel —— Tailwind 的 group-hover 自带 `@media (hover:hover)`
          包装，触屏上那条规则根本不匹配，于是这两个按钮**永远点不到**。
          实测后果：上线至今 workspaces.created_by='trellis' 行数为 0，
          「新建 worktree」入口一次都没被成功用过，而这正是 S1 判据未达标最直接
          的原因。所以补的是 `pointer-coarse:flex`（触屏常显），不是 `md:` 断点
          —— iPad / 触屏笔记本是**大屏且无 hover**，按宽度判会漏掉它们。

          写成「基础态 hidden + 两条互斥的显示规则」而不是「基础 flex + 隐藏
          规则」，是被实测逼出来的：`pointer-fine:hidden` 在产物 CSS 里排在
          `group-hover:flex` **之后**（offset 55476 vs 47049），两者特异性又
          相同（`:where()` 计 0），于是隐藏反过来把 hover 显示覆盖掉，鼠标设备
          上按钮再也出不来 —— 比原来的 bug 还糟。现在两条规则都是「显示」，
          谁先谁后都不影响结果。 */}
      {(onAdd || onRemove) && (
        <div className="shrink-0 hidden group-hover:flex pointer-coarse:flex items-center gap-0.5">
          {onAdd && (
            <RowIconButton title={addTitle} onClick={onAdd}>
              <path d="M12 5v14M5 12h14" />
            </RowIconButton>
          )}
          {onRemove && (
            <RowIconButton
              title="删除这个 worktree（会先列出将被删掉的东西）"
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
  /** 缩进层级：1 = 挂在 Chat / 未归组下，2 = 挂在 Project → Workspace 下 */
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
      style={{ paddingLeft: PAD(indent), height: ROW_H }}
      className={`group relative mx-1 rounded-md flex items-center gap-1.5 pr-1 cursor-pointer transition-colors overflow-hidden ${
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
        </span>
      )}

      {/* CLI 同步：attach 的会话标来源角标（双向绑定）。正被 CLI 实时驱动时
          换成「● live」脉冲（remote-control 式感知）。 */}
      {session.origin === "cli-import" && !editing && (
        live ? (
          <span
            className="shrink-0 inline-flex items-center gap-1 text-nano font-semibold px-1 py-px rounded bg-positive text-ink-inverse group-hover:hidden"
            title={`正被一个活的 ${session.cliProvider === "codex" ? "Codex" : "Claude"} 进程实时驱动`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-ink-inverse animate-pulse" />
            live
          </span>
        ) : (
          <span
            className="shrink-0 text-nano font-semibold px-1 py-px rounded bg-positive-muted text-positive-ink group-hover:hidden"
            title="已 attach 的本机 CLI 会话（双向同步）"
          >
            {session.cliProvider === "codex" ? "CX" : "CC"}
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
