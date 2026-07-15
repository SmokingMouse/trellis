"use client";
import { useEffect, useMemo } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { injectMarks, clearMarks, type MarkSpec } from "@/lib/dom-mark-injector";

// Shared between the qa ResponseBody and ReferenceFullBody (TurnCard) — both
// render markdown that may carry child anchors (qa kids forked from selection)
// and note anchors (excerpts captured from this node). The hook owns the
// imperative <mark> injection and the pendingScrollAnchor flash so neither
// call site has to duplicate ~80 lines of effect code.
//
// Caller must pass `key={node.id}` on the rendered body (or a parent
// component that owns the bodyRef DOM) — this avoids the React reconciler
// tripping over the manually-injected <mark> wrappers when the same fiber's
// content swaps to a new node. See the bug postmortem in
// NotFoundError-removeChild diagnosis.
export function useMarkdownBodyMarks(opts: {
  bodyRef: React.RefObject<HTMLDivElement | null>;
  nodeId: string;
  contentVersion: string;
  suspended: boolean;
}) {
  const { bodyRef, nodeId, contentVersion, suspended } = opts;
  const allNodes = useSessionStore((s) => s.nodes);
  const allNotes = useSessionStore((s) => s.notes);
  const setActiveNode = useSessionStore((s) => s.setActiveNode);
  const pendingScrollAnchor = useSessionStore((s) => s.pendingScrollAnchor);
  const clearScrollAnchor = useSessionStore((s) => s.clearScrollAnchor);

  const childAnchors = useMemo(
    () =>
      Object.values(allNodes)
        .filter((c) => c.parentId === nodeId && c.parentAnchor?.selectedText)
        .map((c) => ({ text: c.parentAnchor!.selectedText, childId: c.id })),
    [allNodes, nodeId],
  );
  const noteAnchors = useMemo(
    () =>
      allNotes
        .filter((n) => n.sourceNodeId === nodeId)
        .map((n) => ({ text: n.quotedText, noteId: n.id })),
    [allNotes, nodeId],
  );
  // Stage 16: transient search anchor injected only while the user is
  // landing on this node from a search result. Cleared once clearScrollAnchor
  // runs (after the pulse fades or the selector misses twice).
  const searchAnchor = useMemo(() => {
    if (!pendingScrollAnchor) return null;
    if (pendingScrollAnchor.kind !== "search") return null;
    if (pendingScrollAnchor.nodeId !== nodeId) return null;
    // matchKind === "question" hits scroll to the QuestionBlock at the
    // top of the view by default — no DOM injection on this body needed.
    if (pendingScrollAnchor.matchKind === "question") return null;
    if (!pendingScrollAnchor.matchText) return null;
    return pendingScrollAnchor.matchText;
  }, [pendingScrollAnchor, nodeId]);

  const onMarkClick = (e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest("[data-child-id]");
    if (!target) return;
    const childId = target.getAttribute("data-child-id");
    if (!childId) return;
    e.preventDefault();
    e.stopPropagation();
    setActiveNode(childId);
  };

  // Inject child + note <mark> on the rendered markdown DOM. Notes
  // first, child second → child marks land *inside* note marks
  // (visually amber inside emerald, which is what we want; click
  // routing via closest still works).
  useEffect(() => {
    if (suspended) return;
    const root = bodyRef.current;
    if (!root) return;
    clearMarks(root);
    const specs: MarkSpec[] = [];
    if (noteAnchors.length) {
      specs.push({
        dataKey: "noteId",
        anchors: noteAnchors.map((a) => ({ text: a.text, id: a.noteId })),
      });
    }
    if (childAnchors.length) {
      specs.push({
        dataKey: "childId",
        anchors: childAnchors.map((a) => ({ text: a.text, id: a.childId })),
      });
    }
    if (searchAnchor) {
      // One search hit at a time → fixed id "current". Pushed last so it
      // lands innermost (matches the note-vs-child layering convention).
      specs.push({
        dataKey: "searchId",
        anchors: [{ text: searchAnchor, id: "current" }],
      });
    }
    if (specs.length) injectMarks(root, specs);
    return () => {
      if (root) clearMarks(root);
    };
  }, [
    suspended,
    contentVersion,
    childAnchors,
    noteAnchors,
    searchAnchor,
    bodyRef,
  ]);

  // Scroll-to-anchor: handles both child-id (jump-back-to-parent) and
  // note-id (jump-from-notebook). A single anchor may span multiple
  // <mark> elements (one per textNode it crossed during DOM injection);
  // querySelectorAll catches them all, scroll the first to center and
  // pulse all. We still wait an rAF for markdown commit + injection
  // effect, retrying once before clearing.
  useEffect(() => {
    if (!pendingScrollAnchor) return;
    if (pendingScrollAnchor.nodeId !== nodeId) return;
    if (suspended) return;
    const selector =
      pendingScrollAnchor.kind === "child"
        ? `mark[data-child-id="${CSS.escape(pendingScrollAnchor.childId)}"]`
        : pendingScrollAnchor.kind === "note"
          ? `mark[data-note-id="${CSS.escape(pendingScrollAnchor.noteId)}"]`
          : `mark[data-search-id="current"]`;
    let raf = 0;
    let timer = 0;
    raf = window.requestAnimationFrame(() => {
      const root = bodyRef.current;
      if (!root) return;
      const targets = root.querySelectorAll<HTMLElement>(selector);
      if (!targets.length) {
        raf = window.requestAnimationFrame(() => {
          const t2 = root.querySelectorAll<HTMLElement>(selector);
          if (t2.length) flash(t2);
          else clearScrollAnchor();
        });
        return;
      }
      flash(targets);
    });
    function flash(els: NodeListOf<HTMLElement>) {
      els[0].scrollIntoView({ block: "center", behavior: "smooth" });
      els.forEach((el) => el.classList.add("anchor-pulse"));
      timer = window.setTimeout(() => {
        els.forEach((el) => el.classList.remove("anchor-pulse"));
        clearScrollAnchor();
      }, 1500);
    }
    return () => {
      window.cancelAnimationFrame(raf);
      if (timer) window.clearTimeout(timer);
    };
  }, [pendingScrollAnchor, nodeId, suspended, clearScrollAnchor, bodyRef]);

  return { onMarkClick };
}
