"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { modeStyle } from "@/lib/mode-style";
import { isEditableTarget } from "@/lib/shortcuts";
import { Plus, X } from "lucide-react";
import { Dots, Icon, IconButton, StatusDot } from "@/components/ui";
import type { Session } from "@/lib/types";

// Workbench Wave 4 — VSCode-style editor tab strip (rewrite of Wave 1).
//
// The tab bar no longer floods every session into a tab. It renders ONLY the
// open editor tabs, exactly like VSCode:
//   • pinned tabs (store.pinnedSessionIds, ordered)
//   • + the single preview tab (store.previewSessionId), if any and not
//     already pinned — shown italic / dimmed to read as "temporary".
//
// Interaction:
//   • single-click a tab → loadSession (plain switch; a preview tab stays
//     preview)
//   • double-click the preview tab → pinSession (keep it open permanently)
//   • each tab has a × close → closeTab (removes from pinned / clears
//     preview; if it was active, switches to a neighbor)
//   • ⌘1–9 jump to the Nth OPEN tab (pinned then preview) — not all sessions
//   • unread dot (unread hue) when a run finished here while the user was
//     away (R3), distinct from the running Dots + sweep bar.
//
// The full session list lives in the left SessionSidebar (incl. its archived
// view). The strip only renders pinned + preview tabs plus a "＋" new entry.
// A redundant "+" sits next to it as a secondary new-session entry.

export function SessionTabs() {
  const activeId = useSessionStore((s) => s.session?.id ?? null);
  const pinnedIds = useSessionStore((s) => s.pinnedSessionIds);
  const previewId = useSessionStore((s) => s.previewSessionId);
  const loadSession = useSessionStore((s) => s.loadSession);
  const pinSession = useSessionStore((s) => s.pinSession);
  const closeTab = useSessionStore((s) => s.closeTab);
  const newConversation = useSessionStore((s) => s.newConversation);
  const sessionsRevision = useSessionStore((s) => s.sessionsRevision);
  const runningIds = useSessionStore((s) => s.runningSessionIds);
  const unreadIds = useSessionStore((s) => s.unreadSessionIds);

  // Zero-latency running state for the session the user is actually looking
  // at: derive it from the live node map instead of waiting up to 1.5s for
  // the /api/runs poll. Non-active sessions still rely on the poll snapshot.
  const activeRunning = useSessionStore((s) =>
    Object.values(s.nodes).some((n) => n.status === "streaming"),
  );
  const isRunning = (id: string) =>
    runningIds.has(id) || (id === activeId && activeRunning);

  // Cache the full session list so we can resolve open tab ids → Session
  // objects (title, mode). Same watch contract as the sidebar/picker.
  const [byId, setById] = useState<Record<string, Session>>({});
  useEffect(() => {
    let cancelled = false;
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const map: Record<string, Session> = {};
        // S117: taskSessions 也要能 resolve —— 从任务页/侧栏分组深链进来的
        // 任务会话（kind='task'）不在 sessions 里，漏掉它 tab 就渲染不出来。
        for (const s of [
          ...(data.sessions ?? []),
          ...(data.taskSessions ?? []),
        ] as Session[])
          map[s.id] = s;
        setById(map);
      })
      .catch(() => {
        /* keep last-known map on transient failure */
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, sessionsRevision]);

  // The ordered list of OPEN tabs: pinned (in order) then the preview tab
  // (if it isn't already pinned). Drives both render and ⌘1–9.
  const openIds = useMemo(() => {
    const ids = [...pinnedIds];
    if (previewId && !pinnedIds.includes(previewId)) ids.push(previewId);
    // Only keep ids we can actually resolve to a session (defends against a
    // just-deleted id lingering for a tick before the store evicts it).
    return ids.filter((id) => byId[id]);
  }, [pinnedIds, previewId, byId]);

  // ⌘1–9 (and Ctrl+1–9 off-mac) jump to the Nth open tab. Ignored while
  // typing so digits with a held modifier still reach inputs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key < "1" || e.key > "9") return;
      if (isEditableTarget(e.target)) return;
      const id = openIds[Number(e.key) - 1];
      if (!id) return;
      e.preventDefault();
      if (id !== activeId) loadSession(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openIds, activeId, loadSession]);

  // Offset the strip to start right of the sidebar. We read the same
  // --trellis-sb var the content surfaces use (set in page.tsx), which
  // already folds in the mobile guard + collapsed state.
  // 移动端整条隐藏（hidden md:block）：tab 条与 hamburger 抽屉的会话列表
  // 功能重叠，还吃掉 2.25rem 纵向空间——手机上会话切换走抽屉。
  return (
    <div
      className="hidden md:block fixed top-12 right-0 z-30 h-9 bg-surface-canvas border-b border-line"
      style={{ left: "var(--trellis-sb, 0px)", top: "calc(3rem + var(--trellis-pending-h, 0px))" }}
    >
      <div className="h-full flex items-stretch overflow-x-auto no-scrollbar px-2 gap-1">
        {openIds.length === 0 && (
          <div className="self-center pl-1 text-label text-ink-faint">
            从侧栏或搜索打开会话；单击是预览，双击标签固定
          </div>
        )}
        {openIds.map((id, i) => {
          const s = byId[id];
          if (!s) return null;
          const isPreview = id === previewId && !pinnedIds.includes(id);
          return (
            <Tab
              key={id}
              session={s}
              active={id === activeId}
              preview={isPreview}
              running={isRunning(id)}
              unread={unreadIds.has(id)}
              shortcut={i + 1}
              onClick={() => {
                if (id !== activeId) loadSession(id);
              }}
              onDoubleClick={() => {
                if (isPreview) pinSession(id);
              }}
              onClose={() => closeTab(id)}
            />
          );
        })}
        <div className="self-center ml-auto pl-1 shrink-0 flex items-center gap-1">
          {/* Redundant secondary new-session entry. */}
          <IconButton label="新会话（全新的树）" size="sm" onClick={() => newConversation()}>
            <Icon icon={Plus} size="sm" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function Tab({
  session,
  active,
  preview,
  running,
  unread,
  shortcut,
  onClick,
  onDoubleClick,
  onClose,
}: {
  session: Session;
  active: boolean;
  preview: boolean;
  running: boolean;
  unread: boolean;
  shortcut: number;
  onClick: () => void;
  onDoubleClick: () => void;
  onClose: () => void;
}) {
  const style = modeStyle(session.mode);
  const ref = useRef<HTMLDivElement>(null);

  // Auto-scroll the active tab into view when it changes (overflow case).
  useEffect(() => {
    if (active) {
      ref.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
    }
  }, [active]);

  return (
    <div
      ref={ref}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      role="tab"
      aria-selected={active}
      title={
        shortcut <= 9
          ? `${style.label} · ${session.title}  (⌘${shortcut})${preview ? "\n双击固定" : ""}`
          : `${style.label} · ${session.title}`
      }
      data-session-tab={session.id}
      data-tab-status={running ? "streaming" : unread ? "unread" : "done"}
      className={`group relative self-center flex items-center gap-1.5 h-7 pl-2.5 pr-1 rounded-md text-ui shrink-0 max-w-[13rem] cursor-pointer transition-colors ${
        active
          ? "bg-surface-muted text-ink-strong"
          : "text-ink-muted hover:bg-surface-hover hover:text-ink"
      } ${unread && !running ? "font-medium" : ""}`}
    >
      {/* 行首一个状态槽：生成中 Dots > 未读点 > 模式点。不再给整个标签染色。 */}
      <span className="flex w-3 shrink-0 items-center justify-center">
        {running ? (
          <Dots />
        ) : unread ? (
          <StatusDot tone="unread" label="完成·未读" />
        ) : (
          <StatusDot tone={session.mode === "project" ? "project" : "chat"} />
        )}
      </span>
      <span className={`truncate ${preview ? "italic" : ""}`}>
        {session.title}
      </span>
      {/* Accent sliding underline bar — peripheral "this one is running" cue. */}
      {running && <span className="trellis-run-bar" aria-hidden />}
      {/* × close — always present, dims until hover to avoid noise. */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        title="关闭标签"
        aria-label="关闭标签"
        className={`shrink-0 size-5 flex items-center justify-center rounded-sm text-ink-faint group-hover:opacity-100 [@media(hover:none)]:opacity-100 hover:bg-surface-hover hover:text-ink transition-opacity ${
          active ? "opacity-100" : "opacity-0"
        }`}
      >
        <Icon icon={X} size="sm" />
      </button>
    </div>
  );
}
