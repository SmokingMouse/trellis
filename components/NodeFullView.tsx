"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import { useSessionStore } from "@/stores/sessionStore";
import { subscribeStream, getStreamPending } from "@/lib/stream-bus";
import { refIcon } from "@/lib/ref-icon";
import { MD_COMPONENTS } from "@/lib/md-components";
import { CopyButton } from "./CopyButton";
import { CardImageButton } from "./CardImageButton";
import { CliResumeButton } from "./CliResumeButton";
import { GeneratedFilesBar } from "./GeneratedFilesBar";
import { isSendCombo, sendHint } from "@/lib/send-key";
import { useSkillSuggestions } from "@/hooks/useSkillSuggestions";
import { SkillPickerList } from "./SkillPickerList";
import { ZoneEditor } from "./ZoneEditor";
import { injectMarks, clearMarks, type MarkSpec } from "@/lib/dom-mark-injector";
import type { ChatNode, NodeAttachment, ParentAnchor } from "@/lib/types";
import { buildNodeIndex } from "@/lib/node-index";
import { NodeTreeOverlay } from "./NodeTreeOverlay";
import { AttachmentPreview } from "./AttachmentPreview";
import { ToolCallsPanel } from "./ToolCallsPanel";
import { InteractionForm } from "./InteractionForm";
import { useConfirmDelete } from "@/hooks/useConfirmDelete";

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_FULL = [rehypeRaw, rehypeHighlight];
// A1: while streaming we render markdown live but skip rehypeRaw — mid-stream
// text often contains a half-typed HTML tag, and raw-HTML parsing on each
// frame is both wasteful and can throw on malformed fragments. Highlighting
// alone is enough for the live view; the final render uses REHYPE_FULL.
const REHYPE_STREAMING = [rehypeHighlight];

type MobileSelection = { text: string; nodeId: string };

// Minimum selected characters before the follow-up bar is offered. Stray
// 1–N char drags / double-clicks on short words shouldn't pop it; a branch
// is a deliberate "ask about this passage" gesture.
const MIN_SELECTION_LEN = 8;

// Selection capture for the follow-up / branch bar. Deliberately conservative
// so it isn't trigger-happy: the bar only commits on a *finished* gesture
// (pointer/touch release, or shift-select keyup), never mid-drag and never on
// a continuous poll. `selectionchange` is used ONLY to dismiss the bar when
// the selection collapses (click away), not to open it.
function useMobileSelection(): MobileSelection | null {
  const [sel, setSel] = useState<MobileSelection | null>(null);
  useEffect(() => {
    const read = (): MobileSelection | null => {
      const s = window.getSelection();
      if (!s || s.isCollapsed || s.rangeCount === 0) return null;
      const text = s.toString().trim();
      if (text.length < MIN_SELECTION_LEN) return null;
      const range = s.getRangeAt(0);
      const container = range.commonAncestorContainer;
      const el =
        container.nodeType === Node.TEXT_NODE
          ? container.parentElement
          : (container as Element);
      const nodeEl = el?.closest("[data-chat-node-id]");
      const nodeId = nodeEl?.getAttribute("data-chat-node-id");
      if (!nodeId) return null;
      return { text, nodeId };
    };
    // Commit on deliberate gesture end only.
    const commit = () => {
      const next = read();
      if (!next) return; // don't clobber an open bar on an unrelated release
      setSel((prev) =>
        prev && prev.text === next.text && prev.nodeId === next.nodeId
          ? prev
          : next,
      );
    };
    // Dismiss when the selection is gone / too short (e.g. user clicked away).
    const onSelectionChange = () => {
      const s = window.getSelection();
      if (
        !s ||
        s.isCollapsed ||
        s.toString().trim().length < MIN_SELECTION_LEN
      ) {
        setSel((prev) => (prev ? null : prev));
      }
    };
    document.addEventListener("pointerup", commit);
    document.addEventListener("touchend", commit);
    document.addEventListener("keyup", commit);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("pointerup", commit);
      document.removeEventListener("touchend", commit);
      document.removeEventListener("keyup", commit);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, []);
  return sel;
}

export function NodeFullView() {
  const session = useSessionStore((s) => s.session);
  const nodes = useSessionStore((s) => s.nodes);
  const activeNodeId = useSessionStore((s) => s.activeNodeId);
  const setActiveNode = useSessionStore((s) => s.setActiveNode);
  const setFullScreen = useSessionStore((s) => s.setFullScreen);
  const markNodeReadAction = useSessionStore((s) => s.markNodeRead);
  const jumpToParentAtAnchor = useSessionStore((s) => s.jumpToParentAtAnchor);
  const onShowCanvas = () => setFullScreen(false);

  // Default to root if nothing is active yet.
  const currentId = activeNodeId ?? session?.rootNodeId ?? null;
  const node = currentId ? nodes[currentId] : null;
  const nodeIndices = useMemo(() => buildNodeIndex(nodes), [nodes]);
  const currentIndex = currentId ? nodeIndices[currentId] ?? 0 : 0;

  const parent = node?.parentId ? nodes[node.parentId] : null;
  const children = useMemo(
    () =>
      node
        ? Object.values(nodes)
            .filter((n) => n.parentId === node.id)
            .sort((a, b) => a.siblingIndex - b.siblingIndex)
        : [],
    [nodes, node],
  );
  const siblings = useMemo(
    () =>
      parent
        ? Object.values(nodes)
            .filter((n) => n.parentId === parent.id && n.id !== node?.id)
            .sort((a, b) => a.siblingIndex - b.siblingIndex)
        : [],
    [nodes, parent, node?.id],
  );

  // Scroll to top of card when switching nodes.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [currentId]);

  // Mark node as read after the user keeps it open for 1s. Streaming /
  // error nodes don't count — only "done" nodes (qa replies that finished
  // generating, references that finished fetching). The 1s gate avoids
  // spurious marks from rapidly tabbing through nodes.
  const nodeStatus = node?.status;
  const nodeReadAt = node?.readAt;
  useEffect(() => {
    if (!currentId) return;
    if (nodeStatus !== "done") return;
    if (nodeReadAt) return;
    const t = window.setTimeout(() => {
      markNodeReadAction(currentId);
    }, 1000);
    return () => window.clearTimeout(t);
  }, [currentId, nodeStatus, nodeReadAt, markNodeReadAction]);

  // Mobile selection → bottom sheet. We cache once observed; iOS clearing
  // the DOM selection later shouldn't dismiss the bar.
  const liveSel = useMobileSelection();
  const [anchorSel, setAnchorSel] = useState<MobileSelection | null>(null);
  useEffect(() => {
    if (liveSel) setAnchorSel(liveSel);
  }, [liveSel]);
  // Drop pending anchor when active node changes.
  useEffect(() => {
    setAnchorSel(null);
  }, [currentId]);

  // Tree overlay — quick "find anywhere" navigation without leaving fullscreen.
  const [treeOpen, setTreeOpen] = useState(false);

  // `B` jumps back to the parent at the anchor mark — same target as the
  // sticky banner click, just hands-on-keys. Only wires up when there's
  // a parent + anchor to return to; ignores presses while typing into
  // any input / textarea / contenteditable, and ignores modifier combos
  // so it doesn't fight with browser shortcuts.
  useEffect(() => {
    if (!parent || !node?.parentAnchor) return;
    const parentId = parent.id;
    const childId = node.id;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "b" && e.key !== "B") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      e.preventDefault();
      jumpToParentAtAnchor(parentId, childId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [parent, node?.id, node?.parentAnchor, jumpToParentAtAnchor]);

  if (!node) {
    return (
      <div
        className="fixed inset-0 pt-[5.25rem] flex items-center justify-center text-stone-400 text-sm"
        style={{ left: "var(--trellis-sb, 0px)" }}
      >
        没有节点可显示
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 pt-[5.25rem] flex flex-col bg-stone-100 dark:bg-stone-950"
      // Wave 4: clear the explorer sidebar (var from page.tsx; 0 on
      // mobile / collapsed). inset-0 sets left:0 — this overrides it.
      style={{ left: "var(--trellis-sb, 0px)" }}
    >
      <SubBar
        onShowCanvas={onShowCanvas}
        onShowTree={() => setTreeOpen(true)}
        node={node}
        parent={parent}
        nodeIndex={currentIndex}
      />
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto my-5 bg-white dark:bg-stone-900 rounded-2xl border border-stone-200 dark:border-stone-800 shadow-sm px-6 py-6">
          {node.kind === "reference" ? (
            <ReferenceFullBody key={node.id} node={node} />
          ) : (
            <>
              {node.parentAnchor && parent && (
                <button
                  onClick={() => jumpToParentAtAnchor(parent.id, node.id)}
                  className="sticky top-0 z-10 w-full text-left -mx-1 mb-3 px-3 py-2 rounded-lg bg-amber-50/95 dark:bg-amber-950/70 border border-amber-200 dark:border-amber-900 text-[12px] text-amber-900 dark:text-amber-200 backdrop-blur active:scale-[0.99] transition-transform shadow-sm hover:bg-amber-100 dark:hover:bg-amber-950"
                  title="回到父节点的引用处 (B)"
                >
                  <span className="text-amber-600 dark:text-amber-400 mr-1">↳</span>
                  从「
                  <span className="font-medium">
                    {truncate(node.parentAnchor.selectedText, 60)}
                  </span>
                  」分叉
                  <span className="ml-1.5 text-amber-700/70 dark:text-amber-300/60">
                    · 点击或按
                    <kbd className="mx-1 px-1 py-px rounded bg-amber-100 dark:bg-amber-900/60 border border-amber-200 dark:border-amber-800 font-mono text-[10px]">
                      B
                    </kbd>
                    回到引用处
                  </span>
                </button>
              )}
              <QuestionBlock
                nodeId={node.id}
                question={node.question}
                attachments={node.attachments}
              />
              <ToolCallsPanel toolCalls={node.toolCalls} />
              {/* key={node.id} forces a fresh ResponseBody fiber per node:
                  the imperative <mark> injection inside react-markdown's
                  output diverges from React's virtual tree, so when the
                  node prop changes in-place React's reconciler tries to
                  removeChild against DOM that was re-parented under our
                  marks and throws NotFoundError. Unmounting cleanly lets
                  the cleanup clearMarks() run before React touches the
                  DOM. */}
              <ResponseBody key={node.id} node={node} />
              {/* A路③: when this node's run is paused on an interactive tool,
                  render the answer form below the response so the user can
                  reply in place and the model continues. */}
              {node.pendingInteraction && (
                <InteractionForm
                  nodeId={node.id}
                  interaction={node.pendingInteraction}
                />
              )}
            </>
          )}
        </div>
      </div>
      <div className="border-t border-stone-200/80 dark:border-stone-800 bg-white/80 dark:bg-stone-900/80 backdrop-blur shrink-0">
        <div className="max-w-3xl mx-auto">
          {anchorSel ? (
            <SelectionBar
              selection={anchorSel}
              onClose={() => {
                setAnchorSel(null);
                window.getSelection()?.removeAllRanges();
              }}
            />
          ) : (
            <>
              <BranchStrip
                parent={parent}
                siblings={siblings}
                childNodes={children}
                onPick={setActiveNode}
              />
              <FollowupBar node={node} />
            </>
          )}
        </div>
      </div>
      <NodeTreeOverlay open={treeOpen} onClose={() => setTreeOpen(false)} />
    </div>
  );
}

function SubBar({
  onShowCanvas,
  onShowTree,
  node,
  parent,
  nodeIndex,
}: {
  onShowCanvas: () => void;
  onShowTree: () => void;
  node: ChatNode;
  parent: ChatNode | null;
  nodeIndex: number;
}) {
  const sessionRootId = useSessionStore((s) => s.session?.rootNodeId);
  const confirmDelete = useConfirmDelete();
  const canDelete = sessionRootId !== node.id;
  return (
    <div className="px-2 py-1.5 border-b border-stone-200/80 dark:border-stone-800 bg-white/80 dark:bg-stone-900/80 backdrop-blur flex items-center gap-1.5 text-xs shrink-0">
      <button
        onClick={onShowCanvas}
        className="px-2 py-1 rounded text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 active:bg-stone-200 dark:active:bg-stone-700 flex items-center gap-1 shrink-0"
        aria-label="回画布"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" />
        </svg>
        <span>画布</span>
      </button>
      <span className="text-stone-300 dark:text-stone-600">›</span>
      <button
        onClick={onShowTree}
        className="flex-1 min-w-0 text-left text-stone-600 dark:text-stone-300 truncate px-1 py-0.5 rounded hover:bg-stone-100 dark:hover:bg-stone-800 active:bg-stone-200 dark:active:bg-stone-700"
        aria-label="打开思维树"
        title="打开思维树"
      >
        {parent && (
          <>
            <span className="text-stone-400 dark:text-stone-500">
              {truncate(
                parent.kind === "reference"
                  ? parent.topicLabel ?? "参考材料"
                  : parent.question,
                16,
              )}
            </span>
            <span className="text-stone-300 dark:text-stone-600 mx-1">›</span>
          </>
        )}
        <span className="text-stone-800 dark:text-stone-200 font-medium">
          {nodeIndex ? (
            <span className="mr-1.5 font-mono text-[11px] text-stone-400 dark:text-stone-500 tabular-nums font-normal">
              #{nodeIndex}
            </span>
          ) : null}
          {node.kind === "reference"
            ? truncate(node.topicLabel ?? "参考材料", 28)
            : truncate(node.question, 28)}
        </span>
      </button>
      {canDelete && (
        <button
          onClick={() => confirmDelete(node.id)}
          className="shrink-0 p-1.5 rounded text-stone-500 dark:text-stone-400 hover:bg-rose-50 dark:hover:bg-rose-950/50 hover:text-rose-600 dark:hover:text-rose-400"
          aria-label="删除节点"
          title="删除节点（含子树）"
        >
          <svg
            width="14"
            height="14"
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
      )}
      <button
        onClick={onShowTree}
        className="shrink-0 p-1.5 rounded text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-800 dark:hover:text-stone-100"
        aria-label="思维树"
        title="思维树"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="6" cy="6" r="2" />
          <circle cx="6" cy="18" r="2" />
          <circle cx="18" cy="12" r="2" />
          <path d="M8 6h4a4 4 0 0 1 4 4v0M8 18h4a4 4 0 0 0 4-4v0" />
        </svg>
      </button>
    </div>
  );
}

// D5: regenerate the same question as a NEW sibling (a second "version"),
// rather than overwriting in place like retry. The existing sibling chips in
// BranchStrip then let the user compare the variants side by side.
function RegenerateVariantButton({
  nodeId,
  question,
}: {
  nodeId: string;
  question: string;
}) {
  const editNode = useSessionStore((s) => s.editNode);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        editNode(nodeId, question);
      }}
      title="用相同问题再生成一个版本（新建兄弟节点，可在分支条对比）"
      className="nodrag px-2.5 py-1 rounded border border-stone-200 dark:border-stone-700 text-[12px] text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
    >
      ↻ 再答一版
    </button>
  );
}

function QuestionBlock({
  nodeId,
  question,
  attachments,
}: {
  nodeId: string;
  question: string;
  attachments: NodeAttachment[];
}) {
  const editNode = useSessionStore((s) => s.editNode);
  const sendKey = useSessionStore((s) => s.sendKey);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(question);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    setEditing(false);
    editNode(nodeId, t);
  };
  const cancel = () => {
    setEditing(false);
    setText(question);
  };

  if (editing) {
    return (
      <div className="bg-indigo-50/70 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-900 rounded-lg px-4 py-3 mb-4">
        <textarea
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (isSendCombo(e, sendKey)) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          rows={3}
          className="w-full resize-none px-3 py-2 rounded-lg border border-indigo-200 dark:border-indigo-800 bg-white dark:bg-stone-900 text-[15px] text-stone-900 dark:text-stone-100 outline-none focus:border-indigo-400 dark:focus:border-indigo-600 leading-relaxed"
        />
        <div className="flex items-center justify-between gap-2 mt-2">
          <span className="text-[11px] text-stone-400 dark:text-stone-500 min-w-0 truncate">
            改问法会新建一个分支，保留原问答（{sendHint(sendKey)}）
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={cancel}
              className="px-2.5 py-1 text-[12px] text-stone-500 hover:text-stone-900 dark:hover:text-stone-100"
            >
              取消
            </button>
            <button
              onClick={submit}
              disabled={!text.trim()}
              className="px-3 py-1 rounded-lg bg-indigo-600 text-white text-[12px] disabled:opacity-40 hover:bg-indigo-700 active:scale-95 transition-transform"
            >
              ↻ 重问
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group bg-indigo-50/60 dark:bg-indigo-950/30 border-l-[3px] border-l-indigo-500 rounded-lg px-4 py-3 mb-5 flex items-start gap-3">
      <div className="w-7 h-7 rounded-full bg-indigo-500 text-white text-[11px] flex items-center justify-center shrink-0 font-medium shadow-sm">
        你
      </div>
      <div className="flex-1 text-[15px] text-stone-800 dark:text-stone-200 leading-relaxed pt-1 font-medium whitespace-pre-wrap min-w-0">
        {question}
        {attachments.length > 0 && (
          <div className="mt-2 font-normal">
            <AttachmentPreview attachments={attachments} readOnly />
          </div>
        )}
      </div>
      <button
        onClick={() => {
          setText(question);
          setEditing(true);
        }}
        title="编辑问题（会新建一个分支重问）"
        aria-label="编辑问题"
        className="shrink-0 mt-0.5 w-7 h-7 flex items-center justify-center rounded-md text-stone-500 dark:text-stone-400 opacity-60 sm:opacity-0 group-hover:opacity-100 hover:bg-white dark:hover:bg-stone-800 hover:text-indigo-600 dark:hover:text-indigo-400 transition-opacity"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      </button>
    </div>
  );
}

// Shared between qa ResponseBody and ReferenceFullBody — both render
// markdown that may carry child anchors (qa kids forked from selection)
// and note anchors (excerpts captured from this node). The hook owns
// the imperative <mark> injection and the pendingScrollAnchor flash so
// neither call site has to duplicate ~80 lines of effect code.
//
// Caller must pass `key={node.id}` on the rendered body (or a parent
// component that owns the bodyRef DOM) — this avoids the React
// reconciler tripping over the manually-injected <mark> wrappers when
// the same fiber's content swaps to a new node. See the bug postmortem
// in NotFoundError-removeChild diagnosis.
function useMarkdownBodyMarks(opts: {
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

function ResponseBody({ node }: { node: ChatNode }) {
  const retryNode = useSessionStore((s) => s.retryNode);
  const bodyRef = useRef<HTMLDivElement>(null);
  const isStreaming = node.status === "streaming";
  const isError = node.status === "error";

  const { onMarkClick } = useMarkdownBodyMarks({
    bodyRef,
    nodeId: node.id,
    contentVersion: node.response,
    suspended: isStreaming,
  });

  // A1: live markdown render while streaming. Accumulate deltas in a ref and
  // flush to state on requestAnimationFrame (coalescing token bursts to one
  // re-render per frame), then render through ReactMarkdown so code/lists/
  // tables format as they arrive — matching GPT/Claude. Affordable here
  // because NodeFullView is a single mounted view, not inside the ReactFlow
  // canvas (ChatNode deliberately keeps the textContent-direct sink there).
  const [liveText, setLiveText] = useState("");
  useEffect(() => {
    if (!isStreaming) return;
    let raf = 0;
    let buf = node.response + getStreamPending(node.id);
    setLiveText(buf);
    const flush = () => {
      raf = 0;
      setLiveText(buf);
    };
    const unsub = subscribeStream(node.id, (delta) => {
      buf += delta;
      if (!raf) raf = requestAnimationFrame(flush);
    });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, node.id]);

  return (
    <div
      ref={bodyRef}
      data-chat-node-id={node.id}
      onClick={onMarkClick}
      className="md-body text-[15px] text-stone-800 dark:text-stone-200 leading-relaxed"
    >
      {isStreaming ? (
        liveText ? (
          <>
            <ReactMarkdown
              remarkPlugins={REMARK_PLUGINS}
              rehypePlugins={REHYPE_STREAMING}
              components={MD_COMPONENTS}
            >
              {liveText}
            </ReactMarkdown>
            <span className="streaming-cursor" />
          </>
        ) : (
          // First token hasn't arrived yet — show an animated indicator
          // instead of a blank pane (the "no streaming" complaint).
          <div className="flex items-center gap-1.5 py-2 text-stone-400 dark:text-stone-500">
            <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
            <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse [animation-delay:150ms]" />
            <span className="w-2 h-2 rounded-full bg-indigo-300 animate-pulse [animation-delay:300ms]" />
            <span className="ml-1.5 text-[13px]">正在生成…</span>
          </div>
        )
      ) : node.response ? (
        <>
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_FULL}
            components={MD_COMPONENTS}
          >
            {node.response}
          </ReactMarkdown>
          <div className="mt-3 flex justify-end gap-2">
            <CliResumeButton nodeId={node.id} />
            <RegenerateVariantButton nodeId={node.id} question={node.question} />
            <CardImageButton
              title={node.topicLabel ?? node.question}
              content={node.response}
            />
            <CopyButton
              text={node.response}
              label="复制全文"
              className="nodrag px-2.5 py-1 rounded border border-stone-200 dark:border-stone-700 text-[12px] text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
            />
          </div>
          <GeneratedFilesBar node={node} />
        </>
      ) : (
        <div className="text-stone-400 dark:text-stone-500 italic flex items-center gap-2">
          <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
          正在生成…
        </div>
      )}
      {isError &&
        (node.errorMessage === "aborted" ? (
          <div className="mt-3 p-2.5 bg-stone-50 dark:bg-stone-800/60 border border-stone-200 dark:border-stone-700 rounded text-stone-600 dark:text-stone-300 text-[13px] flex items-start gap-2">
            <div className="flex-1">已停止生成</div>
            <button
              onClick={() => retryNode(node.id)}
              className="shrink-0 px-2.5 py-1 rounded bg-stone-700 dark:bg-stone-600 text-white text-xs hover:bg-stone-900 dark:hover:bg-stone-500 active:scale-95 transition-transform"
            >
              ↻ 重新发送
            </button>
          </div>
        ) : (
          <div className="mt-3 p-2.5 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded text-rose-700 dark:text-rose-300 text-[13px] flex items-start gap-2">
            <div className="flex-1">出错：{node.errorMessage}</div>
            <button
              onClick={() => retryNode(node.id)}
              className="shrink-0 px-2.5 py-1 rounded bg-rose-600 text-white text-xs hover:bg-rose-700 active:scale-95 transition-transform"
            >
              ↻ 重新生成
            </button>
          </div>
        ))}
    </div>
  );
}

function BranchStrip({
  parent,
  siblings,
  childNodes,
  onPick,
}: {
  parent: ChatNode | null;
  siblings: ChatNode[];
  childNodes: ChatNode[];
  onPick: (id: string) => void;
}) {
  if (!parent && siblings.length === 0 && childNodes.length === 0) return null;
  return (
    <div className="px-3 py-2 flex gap-1.5 overflow-x-auto no-scrollbar">
      {parent && (
        <Chip
          onClick={() => onPick(parent.id)}
          arrow="←"
          label="父"
          text={parent.question}
          tone="stone"
        />
      )}
      {siblings.map((s) => (
        <Chip
          key={s.id}
          onClick={() => onPick(s.id)}
          arrow="↔"
          label="兄弟"
          text={s.question}
          tone="amber"
        />
      ))}
      {childNodes.map((c) => (
        <Chip
          key={c.id}
          onClick={() => onPick(c.id)}
          arrow="→"
          label="子"
          text={c.question}
          tone="indigo"
        />
      ))}
    </div>
  );
}

function Chip({
  onClick,
  arrow,
  label,
  text,
  tone,
}: {
  onClick: () => void;
  arrow: string;
  label: string;
  text: string;
  tone: "stone" | "amber" | "indigo";
}) {
  const tones = {
    stone:
      "bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-300 border-stone-200 dark:border-stone-700 active:bg-stone-200 dark:active:bg-stone-700",
    amber:
      "bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 border-amber-200 dark:border-amber-900 active:bg-amber-100 dark:active:bg-amber-950/60",
    indigo:
      "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-800 dark:text-indigo-200 border-indigo-200 dark:border-indigo-900 active:bg-indigo-100 dark:active:bg-indigo-950/60",
  } as const;
  return (
    <button
      onClick={onClick}
      className={`shrink-0 max-w-[200px] px-2.5 py-1.5 rounded-full border text-[12px] flex items-center gap-1.5 transition-colors ${tones[tone]}`}
    >
      <span className="font-mono text-[11px] opacity-70">{arrow}</span>
      <span className="opacity-60">{label}</span>
      <span className="truncate font-medium">{truncate(text, 22)}</span>
    </button>
  );
}

function SelectionBar({
  selection,
  onClose,
}: {
  selection: MobileSelection;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [zoneOpen, setZoneOpen] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const streamBranch = useSessionStore((s) => s.streamBranch);
  const addNote = useSessionStore((s) => s.addNote);
  const sendKey = useSessionStore((s) => s.sendKey);
  const sessionMode = useSessionStore((s) => s.session?.mode);
  const chatEnhanced = useSessionStore((s) => s.chatEnhanced);
  const matchedSkills = useSkillSuggestions(
    text,
    sessionMode !== "chat" || chatEnhanced,
  );
  const ref = useRef<HTMLTextAreaElement>(null);

  const captureNote = async () => {
    if (savingNote) return;
    setSavingNote(true);
    try {
      await addNote(selection.nodeId, selection.text);
      window.getSelection()?.removeAllRanges();
      onClose();
    } catch (err) {
      console.error("addNote failed", err);
    } finally {
      setSavingNote(false);
    }
  };

  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = "auto";
      ref.current.style.height = `${Math.min(ref.current.scrollHeight, 120)}px`;
    }
  }, [text]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const anchor: ParentAnchor = { selectedText: selection.text };
    setText("");
    onClose();
    streamBranch(selection.nodeId, trimmed, anchor);
  };

  return (
    <div>
      <div className="px-3 py-1.5 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-100 dark:border-amber-900 flex items-center gap-2 text-xs">
        <span className="text-amber-700 dark:text-amber-400 shrink-0">↳</span>
        <span className="flex-1 truncate text-amber-900 dark:text-amber-200">
          针对「
          <span className="font-medium">{truncate(selection.text, 50)}</span>」
        </span>
        <button
          onClick={onClose}
          className="text-amber-700 dark:text-amber-400 active:text-amber-950 dark:active:text-amber-200 px-1 shrink-0"
          aria-label="取消"
        >
          ✕
        </button>
      </div>
      <div className="relative px-3 py-2 flex items-end gap-2">
        <SkillPickerList
          skills={matchedSkills}
          onPick={(name) => {
            setText(`/${name} `);
            ref.current?.focus();
          }}
        />
        <button
          onClick={captureNote}
          disabled={savingNote}
          className="shrink-0 h-[38px] w-[38px] rounded-lg bg-white dark:bg-stone-900 border border-amber-400 dark:border-amber-700 text-amber-700 dark:text-amber-300 flex items-center justify-center disabled:opacity-40 active:scale-95 transition-transform"
          aria-label="摘到笔记"
          title="摘到笔记"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden
          >
            <path d="M12 2C9.243 2 7 4.243 7 7v6.5l-2.707 2.707A1 1 0 0 0 5 18h4v3a1 1 0 1 0 2 0v-3h2v3a1 1 0 1 0 2 0v-3h4a1 1 0 0 0 .707-1.707L17 13.5V7c0-2.757-2.243-5-5-5z" />
          </svg>
        </button>
        <button
          onClick={() => setZoneOpen(true)}
          title="专注写作模式（全屏 Markdown 编辑 + 预览）"
          className="shrink-0 h-[38px] w-[38px] rounded-lg bg-white dark:bg-stone-900 border border-amber-400 dark:border-amber-700 text-amber-700 dark:text-amber-300 flex items-center justify-center active:scale-95 transition-transform"
          aria-label="专注写作"
        >
          <span aria-hidden>⛶</span>
        </button>
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (isSendCombo(e, sendKey)) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder={`针对选中内容追问…（${sendHint(sendKey)}）`}
          className="flex-1 min-h-[38px] max-h-[120px] resize-none px-3 py-2 rounded-lg border border-amber-300 dark:border-amber-800 bg-white dark:bg-stone-900 text-[14px] text-stone-900 dark:text-stone-100 outline-none focus:border-amber-500 dark:focus:border-amber-600 placeholder:text-stone-400 dark:placeholder:text-stone-500"
        />
        <button
          onClick={submit}
          disabled={!text.trim()}
          className="shrink-0 h-[38px] w-[38px] rounded-lg bg-amber-600 text-white flex items-center justify-center disabled:opacity-40 active:scale-95 transition-transform"
          aria-label="提问"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>
      {zoneOpen && (
        <ZoneEditor
          value={text}
          onChange={setText}
          onSubmit={() => {
            if (!text.trim()) return;
            setZoneOpen(false);
            submit();
          }}
          onClose={() => setZoneOpen(false)}
          title={`针对「${truncate(selection.text, 30)}」追问`}
          placeholder="专注写下针对选中内容的追问，支持 Markdown……"
          submitLabel="提问"
          submitDisabled={!text.trim()}
        />
      )}
    </div>
  );
}

function FollowupBar({ node }: { node: ChatNode }) {
  const [text, setText] = useState("");
  const [zoneOpen, setZoneOpen] = useState(false);
  const streamBranch = useSessionStore((s) => s.streamBranch);
  const abortStream = useSessionStore((s) => s.abortStream);
  const sendKey = useSessionStore((s) => s.sendKey);
  const sessionMode = useSessionStore((s) => s.session?.mode);
  const chatEnhanced = useSessionStore((s) => s.chatEnhanced);
  const ref = useRef<HTMLTextAreaElement>(null);
  const isStreaming = node.status === "streaming";
  const matchedSkills = useSkillSuggestions(
    text,
    sessionMode !== "chat" || chatEnhanced,
  );

  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = "auto";
      ref.current.style.height = `${Math.min(ref.current.scrollHeight, 120)}px`;
    }
  }, [text]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    setText("");
    streamBranch(node.id, trimmed, null);
  };

  // Streaming pivot: rather than a useless disabled textarea, the bar
  // becomes a single big stop button. Same screen real estate, but now it
  // does something. Also reachable via Esc (see useEscapeAbort).
  if (isStreaming) {
    return (
      <div className="px-3 py-2">
        <button
          onClick={() => abortStream(node.id)}
          className="w-full h-[38px] rounded-lg border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-700 dark:text-stone-300 hover:bg-stone-900 hover:text-white hover:border-stone-900 dark:hover:bg-stone-100 dark:hover:text-stone-900 dark:hover:border-stone-100 active:scale-[0.99] transition-colors flex items-center justify-center gap-2 text-[13px]"
          aria-label="停止生成"
        >
          <span className="inline-block w-2.5 h-2.5 bg-current rounded-[2px]" />
          停止生成
          <span className="opacity-60 text-[11px] hidden sm:inline">
            （Esc）
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="relative px-3 py-2 flex items-end gap-2">
      {matchedSkills.length > 0 && (
        <div className="absolute bottom-full left-3 right-3 mb-1 z-10 border border-stone-200 dark:border-stone-700 rounded-lg bg-white dark:bg-stone-900 shadow-lg overflow-hidden max-h-56 overflow-y-auto">
          {matchedSkills.map((s) => (
            <button
              key={s.name}
              type="button"
              onClick={() => {
                setText(`/${s.name} `);
                ref.current?.focus();
              }}
              className="w-full text-left px-3 py-2 hover:bg-stone-50 dark:hover:bg-stone-800 border-b last:border-b-0 border-stone-100 dark:border-stone-800"
            >
              <div className="text-[13px] font-mono text-stone-800 dark:text-stone-200">
                /{s.name}
              </div>
              {s.description && (
                <div className="text-[11px] text-stone-500 dark:text-stone-400 truncate">
                  {s.description}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
      <button
        onClick={() => setZoneOpen(true)}
        title="专注写作模式（全屏 Markdown 编辑 + 预览）"
        className="shrink-0 h-[44px] w-[44px] rounded-2xl border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-950 text-stone-500 dark:text-stone-400 flex items-center justify-center hover:text-stone-900 dark:hover:text-stone-100 hover:border-stone-400 active:scale-95 transition-all shadow-sm"
        aria-label="专注写作"
      >
        <span aria-hidden>⛶</span>
      </button>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (isSendCombo(e, sendKey)) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        placeholder={`继续追问，创建子节点…（${sendHint(sendKey)}）`}
        className="flex-1 min-h-[44px] max-h-[140px] resize-none px-4 py-3 rounded-2xl border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-950 text-[14.5px] text-stone-900 dark:text-stone-100 outline-none focus:border-indigo-400 dark:focus:border-indigo-600 focus:ring-2 focus:ring-indigo-100 dark:focus:ring-indigo-900/40 placeholder:text-stone-400 dark:placeholder:text-stone-500 transition-shadow shadow-sm"
      />
      {zoneOpen && (
        <ZoneEditor
          value={text}
          onChange={setText}
          onSubmit={() => {
            if (!text.trim()) return;
            setZoneOpen(false);
            submit();
          }}
          onClose={() => setZoneOpen(false)}
          title="继续追问"
          placeholder="专注写下你的追问，支持 Markdown……"
          submitLabel="提问"
          submitDisabled={!text.trim()}
        />
      )}
      <button
        onClick={submit}
        disabled={!text.trim()}
        className="shrink-0 h-[44px] w-[44px] rounded-2xl bg-indigo-600 text-white flex items-center justify-center disabled:opacity-30 hover:bg-indigo-700 active:scale-95 transition-all shadow-sm"
        aria-label="提问"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 19V5M5 12l7-7 7 7" />
        </svg>
      </button>
    </div>
  );
}

function ReferenceFullBody({ node }: { node: ChatNode }) {
  const refreshReference = useSessionStore((s) => s.refreshReference);
  const abortStream = useSessionStore((s) => s.abortStream);
  const fetchProgress = useSessionStore((s) => s.fetchProgress[node.id]);
  const [refreshing, setRefreshing] = useState(false);
  const ref = node.reference;
  const isStreaming = node.status === "streaming";
  const bodyRef = useRef<HTMLDivElement>(null);
  const { onMarkClick } = useMarkdownBodyMarks({
    bodyRef,
    nodeId: node.id,
    contentVersion: ref?.contentMd ?? "",
    suspended: isStreaming,
  });
  if (!ref) {
    return (
      <div className="text-stone-400 italic text-sm">参考卡片数据缺失</div>
    );
  }
  const canRefresh = ref.sourceType === "url" && !isStreaming;
  const onRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshReference(node.id);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <div
        className={`mb-4 px-4 py-3 rounded-lg border text-[13px] flex items-start gap-2.5 ${
          isStreaming
            ? "bg-indigo-50/60 dark:bg-indigo-950/30 border-indigo-200 dark:border-indigo-900"
            : "bg-amber-50/60 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900"
        }`}
      >
        <span className="text-[18px] leading-none mt-0.5" aria-hidden>
          {isStreaming ? "⏳" : refIcon(ref)}
        </span>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-stone-900 dark:text-stone-100 truncate">
            {node.topicLabel ?? "参考材料"}
          </div>
          {ref.sourceUri && (
            <a
              href={ref.sourceUri}
              target="_blank"
              rel="noreferrer"
              className={`block mt-0.5 truncate underline-offset-2 hover:underline ${
                isStreaming
                  ? "text-indigo-800 dark:text-indigo-300 hover:text-indigo-950 dark:hover:text-indigo-200"
                  : "text-amber-800 dark:text-amber-300 hover:text-amber-950 dark:hover:text-amber-200"
              }`}
              onClick={(e) => e.stopPropagation()}
            >
              {ref.sourceUri}
            </a>
          )}
          {ref.meta.fetchError && !isStreaming && (
            <div className="mt-1 text-rose-700 dark:text-rose-300 text-[12px]">
              ⚠️ 抓取失败：{ref.meta.fetchError}
            </div>
          )}
        </div>
        {isStreaming ? (
          <button
            onClick={() => abortStream(node.id)}
            className="shrink-0 px-2 py-1 text-[11px] rounded border border-stone-300 dark:border-stone-700 text-stone-700 dark:text-stone-300 hover:bg-rose-50 dark:hover:bg-rose-950/40 hover:text-rose-700 dark:hover:text-rose-300 hover:border-rose-300 dark:hover:border-rose-800 active:scale-95 transition-colors"
            title="停止抓取"
          >
            停止
          </button>
        ) : (
          canRefresh && (
            <button
              onClick={onRefresh}
              disabled={refreshing}
              className="shrink-0 px-2 py-1 text-[11px] rounded border border-amber-300 dark:border-amber-800 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-950/60 active:scale-95 disabled:opacity-50 transition-colors"
              title="重新抓取"
            >
              {refreshing ? "抓取中…" : "↻ 刷新"}
            </button>
          )
        )}
      </div>

      {isStreaming && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-stone-50 dark:bg-stone-900 border border-stone-200 dark:border-stone-800">
          <div className="flex items-center gap-2 text-[13px] text-stone-700 dark:text-stone-300">
            <span className="inline-block w-2 h-2 bg-indigo-500 rounded-full animate-pulse" />
            <span className="font-medium">{fetchProgress || "启动中…"}</span>
          </div>
          <div className="mt-2 text-[11px] text-stone-400 dark:text-stone-500 leading-relaxed">
            claude 正在挑选并运行合适的 skill 抓取这个 URL。
            飞书 / YouTube / B站 等通常 5–60 秒，PDF / 大型文档可能更久。
            可以随时点上方"停止"取消。
          </div>
        </div>
      )}

      <div
        ref={bodyRef}
        data-chat-node-id={node.id}
        onClick={onMarkClick}
        className="md-body text-[15px] text-stone-800 dark:text-stone-200 leading-relaxed"
      >
        {ref.contentMd ? (
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_FULL}
            components={MD_COMPONENTS}
          >
            {ref.contentMd}
          </ReactMarkdown>
        ) : isStreaming ? null : (
          <div className="text-stone-400 dark:text-stone-500 italic text-sm">
            {ref.meta.fetchError
              ? "抓取失败，没有内容可显示。点上方刷新重试，或编辑后重新粘贴。"
              : "（没有正文）"}
          </div>
        )}
      </div>
    </>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

