"use client";
import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import type { Session } from "@/lib/types";

export function SessionPicker() {
  const session = useSessionStore((s) => s.session);
  const loadSession = useSessionStore((s) => s.loadSession);
  const newConversation = useSessionStore((s) => s.newConversation);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const renameSession = useSessionStore((s) => s.renameSession);
  const sessionsRevision = useSessionStore((s) => s.sessionsRevision);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [loading, setLoading] = useState(false);
  // Single edit-in-place at a time. null = no row in edit mode.
  const [editingId, setEditingId] = useState<string | null>(null);

  // Fetch list when:
  //  - the dropdown opens (always get the latest)
  //  - the active session id changes (something was created/loaded/deleted)
  //  - sessionsRevision bumps (any mutation in the store)
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setSessions(data.sessions ?? []);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, session?.id, sessionsRevision]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
        setEditingId(null);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const onPickSession = (id: string) => {
    if (editingId) return; // ignore row-clicks while editing
    if (session?.id !== id) loadSession(id);
    setOpen(false);
  };

  const onNew = () => {
    newConversation();
    setOpen(false);
    setEditingId(null);
  };

  const onDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm("永久删除这个对话？\n（节点不可恢复）")) return;
    deleteSession(id);
  };

  const list = sessions ?? [];
  const otherCount = list.filter((s) => s.id !== session?.id).length;
  const triggerLabel = session ? session.title : "新对话";

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-sm text-stone-700 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 max-w-full min-w-0"
        title={triggerLabel}
      >
        <span className="truncate">{triggerLabel}</span>
        {otherCount > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 shrink-0">
            +{otherCount}
          </span>
        )}
        <span className="text-stone-400 dark:text-stone-500">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 mt-1.5 w-96 max-w-[calc(100vw-24px)] bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-lg shadow-xl overflow-hidden text-sm">
          <button
            onClick={onNew}
            className="w-full text-left px-3 py-2.5 hover:bg-stone-50 dark:hover:bg-stone-800 flex items-center gap-2 border-b border-stone-100 dark:border-stone-800"
          >
            <span className="text-stone-400 dark:text-stone-500 text-base">＋</span>
            <span className="text-stone-900 dark:text-stone-100">新对话</span>
          </button>
          <div className="max-h-[60vh] overflow-y-auto">
            {loading && (
              <div className="px-3 py-3 text-xs text-stone-400 dark:text-stone-500 italic">
                加载中…
              </div>
            )}
            {!loading && list.length === 0 && (
              <div className="px-3 py-3 text-xs text-stone-400 dark:text-stone-500 italic">
                还没有对话
              </div>
            )}
            {list.map((s) => (
              <SessionRow
                key={s.id}
                s={s}
                active={s.id === session?.id}
                editing={editingId === s.id}
                onPick={() => onPickSession(s.id)}
                onStartEdit={() => setEditingId(s.id)}
                onCancelEdit={() => setEditingId(null)}
                onCommit={async (next) => {
                  setEditingId(null);
                  if (next.trim() && next.trim() !== s.title) {
                    await renameSession(s.id, next);
                  }
                }}
                onDelete={(e) => onDelete(e, s.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SessionRow({
  s,
  active,
  editing,
  onPick,
  onStartEdit,
  onCancelEdit,
  onCommit,
  onDelete,
}: {
  s: Session;
  active: boolean;
  editing: boolean;
  onPick: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onCommit: (title: string) => Promise<void> | void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(s.title);

  useEffect(() => {
    if (editing) {
      setDraft(s.title);
      // Defer focus until after the render so the input exists; select
      // all so user can immediately overtype.
      const t = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return () => window.clearTimeout(t);
    }
  }, [editing, s.title]);

  return (
    <div
      className={`group flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors ${
        active
          ? "bg-indigo-50/50 dark:bg-indigo-950/30"
          : "hover:bg-stone-50 dark:hover:bg-stone-800"
      }`}
      onClick={editing ? undefined : onPick}
    >
      <span
        className={`shrink-0 w-1.5 h-1.5 rounded-full ${
          active ? "bg-emerald-500" : "bg-stone-300 dark:bg-stone-600"
        }`}
        aria-hidden
      />
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
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
            className="w-full px-1.5 py-0.5 -mx-1.5 -my-0.5 rounded text-[13px] bg-white dark:bg-stone-950 border border-stone-300 dark:border-stone-600 outline-none focus:border-indigo-400 dark:focus:border-indigo-500 text-stone-900 dark:text-stone-100"
          />
        ) : (
          <div
            className={`text-[13px] truncate ${
              active
                ? "font-medium text-indigo-900 dark:text-indigo-200"
                : "text-stone-800 dark:text-stone-200"
            }`}
            title={s.title}
          >
            {s.title}
          </div>
        )}
        <div className="text-[10px] text-stone-400 dark:text-stone-500 mt-0.5">
          {formatDate(s.updatedAt)}
        </div>
      </div>
      {!editing && (
        <div className="shrink-0 flex items-center gap-0.5 opacity-40 group-hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onStartEdit();
            }}
            className="p-1 rounded text-stone-500 dark:text-stone-400 hover:bg-stone-200/70 dark:hover:bg-stone-700 hover:text-stone-900 dark:hover:text-stone-100"
            title="重命名"
            aria-label="重命名"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
          </button>
          <button
            onClick={onDelete}
            className="p-1 rounded text-stone-500 dark:text-stone-400 hover:bg-rose-50 dark:hover:bg-rose-950/50 hover:text-rose-600 dark:hover:text-rose-300"
            title="删除"
            aria-label="删除"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
