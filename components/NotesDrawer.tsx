"use client";
import { useEffect, useMemo } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { buildNodeIndex } from "@/lib/node-index";
import type { Note } from "@/lib/types";

// Right-side drawer (mobile = bottom sheet) listing the session's
// notebook entries. Each row shows the quoted excerpt, source node ref
// (#N · topic), and two actions: jump back (sets activeNodeId +
// fullScreen + pendingScrollAnchor for scroll-to-mark) and delete.
//
// Skeleton mirrors NodeTreeOverlay so transitions / backdrop / mobile
// breakpoints feel consistent.
export function NotesDrawer() {
  const open = useSessionStore((s) => s.notesOpen);
  const setNotesOpen = useSessionStore((s) => s.setNotesOpen);
  const notes = useSessionStore((s) => s.notes);
  const nodes = useSessionStore((s) => s.nodes);
  const setActiveNode = useSessionStore((s) => s.setActiveNode);
  const setFullScreen = useSessionStore((s) => s.setFullScreen);
  const jumpToParentAtAnchor = useSessionStore((s) => s.jumpToParentAtAnchor);
  const deleteNote = useSessionStore((s) => s.deleteNote);

  const indices = useMemo(() => buildNodeIndex(nodes), [nodes]);

  // Esc closes the drawer (matches every other modal in trellis).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNotesOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setNotesOpen]);

  const onJump = (note: Note) => {
    // pendingScrollAnchor was originally built for "jump from child back
    // to parent + highlight the source mark". Same machinery works for
    // "jump from note → source node + highlight the same anchor", because
    // the source node's ResponseBody also injects <mark data-child-id="X">
    // for any of its children whose parentAnchor matches an anchor child.
    //
    // For notes, there's no child-id to anchor on — we use the note id as
    // the marker. ResponseBody's existing scroll handler queries
    // `mark[data-child-id="<id>"]`; for notes we'd need either:
    //   (a) inject a separate <mark> for each note's quoted_text in the
    //       source node's body, OR
    //   (b) just navigate to the source node without scroll anchoring.
    //
    // For now go with (b) — simpler, still useful (you land on the right
    // node, fullscreen). If users say "I lose the sentence" we wire (a)
    // by extending injectHighlights to also overlay note marks.
    setActiveNode(note.sourceNodeId);
    setFullScreen(true);
    setNotesOpen(false);
    // Suppress lint — jumpToParentAtAnchor is intentionally unused here
    // (kept imported for future option-(a) wiring). We close over it via
    // a no-op call to make the linter happy.
    void jumpToParentAtAnchor;
  };

  return (
    <div
      className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      <div
        onClick={() => setNotesOpen(false)}
        className={`absolute inset-0 bg-black/40 sm:bg-black/15 transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />
      <div
        className={`absolute bg-white dark:bg-stone-900 shadow-2xl flex flex-col overflow-hidden transition-transform duration-200
          inset-x-0 bottom-0 h-[60vh] rounded-t-2xl
          sm:inset-x-auto sm:right-2 sm:top-14 sm:bottom-2 sm:w-[360px] sm:h-auto sm:rounded-xl
          ${
            open
              ? "translate-y-0 sm:translate-x-0"
              : "translate-y-full sm:translate-y-0 sm:translate-x-[calc(100%+0.5rem)]"
          }`}
      >
        <div className="px-4 py-3 border-b border-stone-200 dark:border-stone-800 flex items-center gap-2 shrink-0">
          <div className="text-stone-400 dark:text-stone-500 uppercase tracking-wider text-[10px] font-medium">
            笔记
          </div>
          <div className="text-stone-400 dark:text-stone-500 text-xs">
            · {notes.length} 条
          </div>
          <button
            onClick={() => setNotesOpen(false)}
            className="ml-auto text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 text-sm px-2 py-0.5"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-2 px-3">
          {notes.length === 0 ? (
            <div className="text-stone-400 dark:text-stone-500 text-xs text-center py-8 leading-relaxed">
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
      </div>
    </div>
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
