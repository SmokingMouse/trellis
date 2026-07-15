"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { ancestorsOf } from "@/lib/collapsed";
import { buildNodeIndex } from "@/lib/node-index";
import { subscribeStream } from "@/lib/stream-bus";
import { modeStyle } from "@/lib/mode-style";
import { sendHint } from "@/lib/send-key";
import {
  useSelectionWithin,
  type SelectionInfo,
} from "@/hooks/useSelectionWithin";
import { useConfirmDelete } from "@/hooks/useConfirmDelete";
import type { ChatNode } from "@/lib/types";
import { BranchPopover } from "./BranchPopover";
import { Composer } from "./Composer";
import { ThreadMinimap } from "./ThreadMinimap";
import { TurnCard } from "./TurnCard";

// #7: the unified reading/chat surface for EVERY mode (chat / workspace /
// project). One thread anchored at the active node: ancestors above, the
// first-child chain below, non-thread children folded into "↳ N 个分支"
// rows. Cards are fully interactive (TurnCard: edit question, ⌘K selection
// branching via BranchPopover, regenerate, copy, interaction forms), and the
// sticky bottom composer continues the displayed lineage — this replaced the
// old NodeFullView fullscreen reader (issues #2/#4/#7).

function nodeSort(a: ChatNode, b: ChatNode) {
  return (
    a.siblingIndex - b.siblingIndex ||
    a.createdAt - b.createdAt ||
    a.id.localeCompare(b.id)
  );
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function firstRoot(nodes: Record<string, ChatNode>, rootNodeId?: string | null) {
  if (rootNodeId && nodes[rootNodeId]) return nodes[rootNodeId];
  return Object.values(nodes)
    .filter((n) => !n.parentId)
    .sort(nodeSort)[0] ?? null;
}

function childrenIndex(nodes: Record<string, ChatNode>) {
  const byParent = new Map<string, ChatNode[]>();
  for (const n of Object.values(nodes)) {
    if (!n.parentId) continue;
    const arr = byParent.get(n.parentId) ?? [];
    arr.push(n);
    byParent.set(n.parentId, arr);
  }
  for (const arr of byParent.values()) arr.sort(nodeSort);
  return byParent;
}

// How close to the bottom (px) still counts as "following" — scrolling
// further up than this pauses the stream auto-follow until the user returns.
const FOLLOW_SLACK_PX = 120;

export function LinearThreadView() {
  const session = useSessionStore((s) => s.session);
  const nodes = useSessionStore((s) => s.nodes);
  const activeNodeId = useSessionStore((s) => s.activeNodeId);
  const setActiveNode = useSessionStore((s) => s.setActiveNode);
  const setViewMode = useSessionStore((s) => s.setViewMode);
  const markNodeRead = useSessionStore((s) => s.markNodeRead);
  const jumpToParentAtAnchor = useSessionStore((s) => s.jumpToParentAtAnchor);
  const sendKey = useSessionStore((s) => s.sendKey);
  const confirmDelete = useConfirmDelete();
  const nodeIndices = useMemo(() => buildNodeIndex(nodes), [nodes]);
  const [openBranches, setOpenBranches] = useState<Set<string>>(new Set());
  const roundRefs = useRef(new Map<string, HTMLDivElement>());
  const scrollRef = useRef<HTMLDivElement>(null);
  // #6: sticky-to-bottom while the tip streams. True = keep pinning the
  // viewport to the bottom on new content; flips off when the user scrolls
  // up past FOLLOW_SLACK_PX, back on when they return to the bottom.
  const followRef = useRef(true);

  useEffect(() => {
    setOpenBranches(new Set());
  }, [session?.id]);

  const threadData = useMemo(() => {
    const anchor =
      activeNodeId && nodes[activeNodeId]
        ? nodes[activeNodeId]
        : firstRoot(nodes, session?.rootNodeId);
    if (!anchor) {
      return {
        anchorId: null,
        thread: [] as ChatNode[],
        branchesByNode: new Map<string, ChatNode[]>(),
      };
    }

    const byParent = childrenIndex(nodes);
    const up = ancestorsOf(anchor.id, nodes)
      .reverse()
      .map((id) => nodes[id])
      .filter((n): n is ChatNode => Boolean(n));
    const down: ChatNode[] = [];
    let cur: ChatNode | undefined = anchor;
    while (cur) {
      const child: ChatNode | undefined = byParent.get(cur.id)?.[0];
      if (!child) break;
      down.push(child);
      cur = child;
    }
    const thread = [...up, anchor, ...down];
    const nextByNode = new Map<string, string>();
    for (let i = 0; i < thread.length - 1; i++) {
      nextByNode.set(thread[i].id, thread[i + 1].id);
    }
    const branchesByNode = new Map<string, ChatNode[]>();
    for (const n of thread) {
      const nextId = nextByNode.get(n.id);
      const branches = (byParent.get(n.id) ?? []).filter((c) => c.id !== nextId);
      if (branches.length > 0) branchesByNode.set(n.id, branches);
    }
    return { anchorId: anchor.id, thread, branchesByNode };
  }, [activeNodeId, nodes, session?.rootNodeId]);

  const tipNode =
    threadData.thread.length > 0
      ? threadData.thread[threadData.thread.length - 1]
      : null;
  const tipStreamingId =
    tipNode && tipNode.status === "streaming" ? tipNode.id : null;
  const anchorNode = threadData.anchorId ? nodes[threadData.anchorId] : null;

  // Anchor navigation → scroll the anchored card into view. Skipped while the
  // anchor IS the streaming tip: the bottom-lock below owns the viewport then
  // (centering a growing card would fight it every frame).
  useEffect(() => {
    if (!threadData.anchorId) return;
    if (threadData.anchorId === tipStreamingId) return;
    const id = requestAnimationFrame(() => {
      roundRefs.current
        .get(threadData.anchorId!)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadData.anchorId]);

  // #6: bottom-lock during streaming. Deltas bypass React (stream-bus), so we
  // subscribe directly and pin scrollTop per animation frame while following.
  useEffect(() => {
    if (!tipStreamingId) return;
    followRef.current = true;
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const pin = () => {
      raf = 0;
      if (followRef.current && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    };
    pin();
    const unsub = subscribeStream(tipStreamingId, () => {
      if (!raf) raf = requestAnimationFrame(pin);
    });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      unsub();
    };
  }, [tipStreamingId]);

  // Store-driven growth while streaming (tool-call panel rows, interaction
  // forms) doesn't emit stream deltas — re-pin after those renders too.
  useEffect(() => {
    if (!tipStreamingId || !followRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX;
  };

  // Read tracking: a card counts as read once it stays sufficiently visible
  // in the scroll viewport for 1s — ≥50% of the card showing, or (for cards
  // taller than the screen) filling ≥50% of the viewport. The old contract
  // marked only the anchor node, so scrolling through the thread never
  // registered reads — you had to click each node in from the canvas.
  const readTimers = useRef(new Map<string, number>());
  const visibleIds = useRef(new Set<string>());
  const observerRef = useRef<IntersectionObserver | null>(null);

  const scheduleRead = (id: string) => {
    if (readTimers.current.has(id)) return;
    const node = useSessionStore.getState().nodes[id];
    if (!node || node.status !== "done" || node.readAt) return;
    readTimers.current.set(
      id,
      window.setTimeout(() => {
        readTimers.current.delete(id);
        const cur = useSessionStore.getState().nodes[id];
        if (cur && cur.status === "done" && !cur.readAt) void markNodeRead(id);
      }, 1000),
    );
  };
  const cancelRead = (id: string) => {
    const t = readTimers.current.get(id);
    if (t !== undefined) {
      window.clearTimeout(t);
      readTimers.current.delete(id);
    }
  };

  useEffect(() => {
    const rootEl = scrollRef.current;
    if (!rootEl) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.threadNodeId;
          if (!id) continue;
          const rootH = entry.rootBounds?.height ?? 0;
          const seen =
            entry.isIntersecting &&
            (entry.intersectionRatio >= 0.5 ||
              (rootH > 0 && entry.intersectionRect.height >= rootH * 0.5));
          if (seen) {
            visibleIds.current.add(id);
            scheduleRead(id);
          } else {
            visibleIds.current.delete(id);
            cancelRead(id);
          }
        }
      },
      // Fine-grained thresholds so tall cards (whose ratio never reaches 0.5)
      // still fire when their visible slice crosses half the viewport.
      { root: rootEl, threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] },
    );
    observerRef.current = obs;
    for (const el of roundRefs.current.values()) obs.observe(el);
    return () => {
      obs.disconnect();
      observerRef.current = null;
      for (const t of readTimers.current.values()) window.clearTimeout(t);
      readTimers.current.clear();
      visibleIds.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  // A reply that finishes streaming usually sits right in the viewport — no
  // intersection change fires then, so re-check visible cards on node updates.
  useEffect(() => {
    for (const id of visibleIds.current) scheduleRead(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes]);

  // `B` jumps back to the anchored node's parent at its anchor mark (same
  // target as clicking the card's "从「…」分叉" banner). Ignores presses while
  // typing and modifier combos.
  useEffect(() => {
    if (!anchorNode?.parentAnchor || !anchorNode.parentId) return;
    if (!nodes[anchorNode.parentId]) return;
    const parentId = anchorNode.parentId;
    const childId = anchorNode.id;
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
  }, [anchorNode, nodes, jumpToParentAtAnchor]);

  // ⌘K selection branching + ⌘D note capture over any card body — the same
  // BranchPopover the canvas uses (bodies carry data-chat-node-id).
  const liveSelection = useSelectionWithin();
  const [popover, setPopover] = useState<{
    selection: SelectionInfo;
    expanded: boolean;
  } | null>(null);
  useEffect(() => {
    setPopover((prev) => {
      if (prev?.expanded) return prev;
      if (liveSelection) return { selection: liveSelection, expanded: false };
      return null;
    });
  }, [liveSelection]);

  const setRoundRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) {
      roundRefs.current.set(id, el);
      observerRef.current?.observe(el);
    } else {
      const prev = roundRefs.current.get(id);
      if (prev) observerRef.current?.unobserve(prev);
      roundRefs.current.delete(id);
      visibleIds.current.delete(id);
      cancelRead(id);
    }
  };

  const toggleBranches = (nodeId: string) => {
    setOpenBranches((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  if (!session) return null;
  const mode = modeStyle(session.mode);

  return (
    // #3: viewport-bound flex column — header and composer are fixed rails,
    // only the middle scrolls. `sticky bottom-0` was NOT this: with less than
    // a screen of content the composer sat right under the last card,
    // floating mid-screen instead of docked at the bottom.
    <div
      className="fixed inset-0 pt-[5.25rem] flex flex-col bg-stone-50 dark:bg-stone-950"
      style={{ left: "var(--trellis-sb, 0px)" }}
    >
      <div className="shrink-0 z-30 border-b border-stone-200/80 dark:border-stone-800 bg-stone-50/90 dark:bg-stone-950/90 backdrop-blur">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-wide text-stone-400 dark:text-stone-500 flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${mode.dot}`} aria-hidden />
              {mode.label} · 线性
            </div>
            <h1 className="truncate text-sm font-semibold text-stone-900 dark:text-stone-100">
              {session.title}
            </h1>
          </div>
          <button
            type="button"
            onClick={() => setViewMode("canvas")}
            className="shrink-0 px-3 py-1.5 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-xs font-medium text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 active:scale-95 transition"
          >
            🗺 画布
          </button>
        </div>
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
        <main className="max-w-3xl mx-auto px-4 py-5 pb-6 space-y-4">
        {threadData.thread.length === 0 ? (
          <div className="rounded-lg border border-dashed border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 px-4 py-8 text-center text-sm text-stone-500 dark:text-stone-400">
            暂无节点
          </div>
        ) : (
          threadData.thread.map((node, idx) => {
            const branches = threadData.branchesByNode.get(node.id) ?? [];
            const isActive = node.id === threadData.anchorId;
            const canDelete =
              session.rootNodeId !== node.id && node.status !== "streaming";
            return (
              <section
                key={node.id}
                ref={setRoundRef(node.id)}
                data-thread-node-id={node.id}
                className={`rounded-lg border bg-white dark:bg-stone-900 shadow-sm transition-colors ${
                  isActive
                    ? "border-indigo-300 dark:border-indigo-700 ring-2 ring-indigo-100 dark:ring-indigo-950"
                    : "border-stone-200 dark:border-stone-800"
                }`}
              >
                <div className="px-4 py-2.5 border-b border-stone-100 dark:border-stone-800 flex items-center gap-2 text-xs">
                  <span className="font-mono text-stone-400 dark:text-stone-500">
                    #{nodeIndices[node.id] ?? idx + 1}
                  </span>
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      node.status === "streaming"
                        ? "bg-indigo-500 animate-pulse"
                        : node.status === "error"
                          ? "bg-rose-500"
                          : node.readAt
                            ? "bg-stone-300 dark:bg-stone-600"
                            : "bg-amber-400"
                    }`}
                  />
                  <span className="text-stone-500 dark:text-stone-400">
                    {node.kind === "reference" ? "Reference" : "Turn"}
                  </span>
                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => confirmDelete(node.id)}
                      className="ml-auto px-1.5 py-1 rounded-md text-stone-400 dark:text-stone-500 hover:bg-rose-50 dark:hover:bg-rose-950/50 hover:text-rose-600 dark:hover:text-rose-400 transition-colors"
                      title="删除节点（含子树）"
                      aria-label="删除节点"
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                        <path d="M10 11v6M14 11v6" />
                      </svg>
                    </button>
                  )}
                </div>

                <div className="px-4 py-4">
                  <TurnCard node={node} />

                  {branches.length > 0 && (
                    <div className="mt-4 pt-2 border-t border-stone-100 dark:border-stone-800">
                      <button
                        type="button"
                        onClick={() => toggleBranches(node.id)}
                        className="text-xs font-medium text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100"
                      >
                        ↳ {branches.length} 个分支
                      </button>
                      {openBranches.has(node.id) && (
                        <div className="mt-2 space-y-1.5">
                          {branches.map((branch) => (
                            <button
                              key={branch.id}
                              type="button"
                              onClick={() => setActiveNode(branch.id)}
                              className="w-full text-left px-3 py-2 rounded-lg bg-amber-50/70 dark:bg-amber-950/30 border border-amber-100 dark:border-amber-900/70 hover:bg-amber-100 dark:hover:bg-amber-950/60 transition-colors"
                            >
                              <div className="flex items-center gap-2 text-[11px] text-amber-700/80 dark:text-amber-300/80">
                                <span className="font-mono">
                                  #{nodeIndices[branch.id] ?? "?"}
                                </span>
                                <span>{branch.kind === "reference" ? "reference" : "branch"}</span>
                              </div>
                              <div className="mt-0.5 truncate text-xs text-stone-700 dark:text-stone-200">
                                {branch.topicLabel ?? truncate(branch.question, 120)}
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </section>
            );
          })
        )}
        </main>
      </div>

      <div className="shrink-0 z-20 border-t border-stone-200/80 dark:border-stone-800 bg-stone-50/95 dark:bg-stone-950/95 backdrop-blur">
        <div className="max-w-3xl mx-auto px-4">
          <Composer
            targetNode={tipNode}
            placeholder={`继续对话…（${sendHint(sendKey)}，选中文字可 ⌘K 分叉追问）`}
          />
        </div>
      </div>

      {popover?.selection && (
        <BranchPopover
          selection={popover.selection}
          expanded={popover.expanded}
          onExpand={() =>
            setPopover((prev) => (prev ? { ...prev, expanded: true } : prev))
          }
          onClose={() => {
            setPopover(null);
            window.getSelection()?.removeAllRanges();
          }}
        />
      )}
      <ThreadMinimap />
    </div>
  );
}
