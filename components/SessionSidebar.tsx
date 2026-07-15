"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { modeStyle } from "@/lib/mode-style";
import { Dots } from "@/components/ui/Dots";
import { CliAttachPicker } from "@/components/CliAttachPicker";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { SIDEBAR_W } from "@/lib/workbench-layout";
import type { Session } from "@/lib/types";

// Workbench Wave 4 — VSCode-style left explorer sidebar (R1 + R2 + R3).
//
//  R1  Always-present desktop rail (md:block, ~210px). Lists every
//      unarchived session grouped by mode (Chat / Workspace·Project),
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

  // Zero-latency running state for the active session (derive from live nodes
  // rather than waiting for the /api/runs poll); non-active rows use the poll.
  const activeRunning = useSessionStore((s) =>
    Object.values(s.nodes).some((n) => n.status === "streaming"),
  );
  const isRunning = (id: string) =>
    runningIds.has(id) || (id === activeId && activeRunning);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
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

  const { chat, work } = useMemo(() => {
    const chat: Session[] = [];
    const work: Session[] = [];
    for (const s of sessions) {
      if ((s.mode || "chat") === "chat") chat.push(s);
      else work.push(s);
    }
    return { chat, work };
  }, [sessions]);

  const onNew = () => {
    newConversation();
    setEditingId(null);
  };

  const renderGroup = (label: string, list: Session[]) =>
    list.length === 0 ? null : (
      <div className="mb-2">
        <div className="px-2 pt-1 pb-0.5 text-nano uppercase tracking-wider font-medium text-ink-faint">
          {label}
        </div>
        {list.map((s) => (
          <SidebarRow
            key={s.id}
            session={s}
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
        ))}
      </div>
    );

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
            {renderGroup("Chat", chat)}
            {renderGroup("Workspace · Project", work)}
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
          style={{ width: SIDEBAR_W }}
        >
          {renderPanel(() => setSidebarOpen(false))}
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

function SidebarRow({
  session,
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
