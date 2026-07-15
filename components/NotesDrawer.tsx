"use client";
import { useMemo } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { buildNodeIndex } from "@/lib/node-index";
import { Drawer } from "@/components/ui/Drawer";
import { IconButton } from "@/components/ui/IconButton";
import type { Note } from "@/lib/types";

// Right-side drawer (mobile = bottom sheet) listing the session's
// notebook entries. Each row shows the quoted excerpt, source node ref
// (#N · topic), and two actions: jump back (sets activeNodeId +
// pendingScrollAnchor for scroll-to-mark) and delete.
// 外壳（scrim/滑入/Esc）来自 ui/Drawer 原语。
export function NotesDrawer() {
  const open = useSessionStore((s) => s.notesOpen);
  const setNotesOpen = useSessionStore((s) => s.setNotesOpen);
  const notes = useSessionStore((s) => s.notes);
  const nodes = useSessionStore((s) => s.nodes);
  const jumpToNoteSource = useSessionStore((s) => s.jumpToNoteSource);
  const deleteNote = useSessionStore((s) => s.deleteNote);

  const indices = useMemo(() => buildNodeIndex(nodes), [nodes]);

  // Jump-to-source: store action handles activeNodeId +
  // pendingScrollAnchor in one set(), and ResponseBody scrolls/pulses
  // the matching mark[data-note-id]. Drawer self-closes via setNotesOpen
  // inside the action.
  const onJump = (note: Note) => jumpToNoteSource(note.id);

  return (
    <Drawer open={open} onClose={() => setNotesOpen(false)}>
      <div className="px-4 py-3 border-b border-line flex items-center gap-2 shrink-0">
        <div className="text-ink-faint uppercase tracking-wider text-nano font-medium">
          笔记
        </div>
        <div className="text-ink-faint text-xs">· {notes.length} 条</div>
        <IconButton
          label="关闭"
          size="sm"
          className="ml-auto"
          onClick={() => setNotesOpen(false)}
        >
          ✕
        </IconButton>
      </div>
      <div className="flex-1 overflow-y-auto py-2 px-3">
        {notes.length === 0 ? (
          <div className="text-ink-faint text-xs text-center py-8 leading-relaxed">
            还没有笔记。
            <br />
            在阅读时选中文字 → ⌘D 或 📌 按钮即可摘录。
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {notes.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                sourceIndex={indices[note.sourceNodeId] ?? 0}
                sourceTopic={topicForSource(note, nodes)}
                onJump={() => onJump(note)}
                onDelete={() => deleteNote(note.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </Drawer>
  );
}

function NoteRow({
  note,
  sourceIndex,
  sourceTopic,
  onJump,
  onDelete,
}: {
  note: Note;
  sourceIndex: number;
  sourceTopic: string;
  onJump: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50/60 dark:bg-amber-950/20 overflow-hidden">
      <button
        onClick={onJump}
        className="w-full text-left px-3 py-2 hover:bg-amber-100/60 dark:hover:bg-amber-950/40 active:scale-[0.99] transition-transform"
      >
        <div className="text-[13px] text-stone-800 dark:text-stone-200 leading-relaxed whitespace-pre-wrap break-words">
          {note.quotedText}
        </div>
      </button>
      <div className="px-3 py-1.5 border-t border-amber-200/70 dark:border-amber-900/40 flex items-center gap-2 text-[10.5px] text-stone-500 dark:text-stone-400">
        <span className="font-mono tabular-nums">
          {sourceIndex ? `#${sourceIndex}` : "—"}
        </span>
        <span className="text-stone-300 dark:text-stone-600">·</span>
        <span className="flex-1 truncate" title={sourceTopic}>
          {sourceTopic}
        </span>
        <button
          onClick={onJump}
          className="shrink-0 text-amber-700 dark:text-amber-400 hover:text-amber-900 dark:hover:text-amber-200"
          title="跳到原文"
          aria-label="跳到原文"
        >
          ↗
        </button>
        <button
          onClick={onDelete}
          className="shrink-0 text-stone-400 dark:text-stone-500 hover:text-rose-600 dark:hover:text-rose-400"
          title="删除"
          aria-label="删除"
        >
          ×
        </button>
      </div>
    </li>
  );
}

function topicForSource(
  note: Note,
  nodes: Record<string, import("@/lib/types").ChatNode>,
): string {
  const src = nodes[note.sourceNodeId];
  if (!src) return "（来源节点已删除）";
  if (src.kind === "reference") {
    return src.topicLabel ?? "参考材料";
  }
  return src.topicLabel ?? truncate(src.question, 40);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
