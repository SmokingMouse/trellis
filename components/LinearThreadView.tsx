"use client";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { ancestorsOf } from "@/lib/collapsed";
import { isContextCompacted } from "@/lib/context-usage";
import { buildNodeIndex } from "@/lib/node-index";
import { childrenIndex, nodeSort } from "@/lib/tree-panel";
import { subscribeStream } from "@/lib/stream-bus";
import { modeStyle } from "@/lib/mode-style";
import { sendHint } from "@/lib/send-key";
import {
  THREAD_WIDTH_CLASS,
  THREAD_WIDTH_OPTIONS,
} from "@/lib/thread-width";
import { isEditableTarget } from "@/lib/shortcuts";
import {
  useSelectionWithin,
  type SelectionInfo,
} from "@/hooks/useSelectionWithin";
import { useConfirmDelete } from "@/hooks/useConfirmDelete";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { ChatNode } from "@/lib/types";
import { BranchPopover } from "./BranchPopover";
import { Composer } from "./Composer";
import { TargetChip } from "./TargetChip";
import { TurnCard } from "./TurnCard";

// #7: the unified reading/chat surface for EVERY mode (chat /
// project). One thread anchored at the active node: ancestors above, the
// first-child chain below, non-thread children folded into "↳ N 个分支"
// rows. Cards are fully interactive (TurnCard: edit question, ⌘K selection
// branching via BranchPopover, regenerate, copy, interaction forms), and the
// sticky bottom composer continues the displayed lineage — this replaced the
// old NodeFullView fullscreen reader (issues #2/#4/#7).

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function firstRoot(nodes: Record<string, ChatNode>, rootNodeId?: string | null) {
  if (rootNodeId && nodes[rootNodeId]) return nodes[rootNodeId];
  return Object.values(nodes)
    .filter((n) => !n.parentId)
    .sort(nodeSort)[0] ?? null;
}

// How close to the bottom (px) still counts as "following" — scrolling
// further up than this pauses the stream auto-follow until the user returns.
const FOLLOW_SLACK_PX = 120;

export function LinearThreadView() {
  const isMobile = useIsMobile();
  const session = useSessionStore((s) => s.session);
  const nodes = useSessionStore((s) => s.nodes);
  const activeNodeId = useSessionStore((s) => s.activeNodeId);
  const setActiveNode = useSessionStore((s) => s.setActiveNode);
  const setReadingPosition = useSessionStore((s) => s.setReadingPosition);
  const setViewMode = useSessionStore((s) => s.setViewMode);
  const markNodeRead = useSessionStore((s) => s.markNodeRead);
  const markNodeUnread = useSessionStore((s) => s.markNodeUnread);
  const jumpToParentAtAnchor = useSessionStore((s) => s.jumpToParentAtAnchor);
  const sendKey = useSessionStore((s) => s.sendKey);
  const threadWidth = useSessionStore((s) => s.threadWidth);
  const setThreadWidth = useSessionStore((s) => s.setThreadWidth);
  const confirmDelete = useConfirmDelete();
  const nodeIndices = useMemo(() => buildNodeIndex(nodes), [nodes]);
  const [openBranches, setOpenBranches] = useState<Set<string>>(new Set());
  // Retargets the bottom composer at an intermediate node (reply-to style):
  // the ⑂ button on a card arms it, submit/Esc/✕ disarm it. `n` is a nonce so
  // re-clicking the same card re-pulls focus into the composer.
  const [branchFrom, setBranchFrom] = useState<{ id: string; n: number } | null>(
    null,
  );
  const roundRefs = useRef(new Map<string, HTMLDivElement>());
  const scrollRef = useRef<HTMLDivElement>(null);
  // #6: sticky-to-bottom while the tip streams. True = keep pinning the
  // viewport to the bottom on new content; flips off when the user scrolls
  // up past FOLLOW_SLACK_PX, back on when they return to the bottom.
  const followRef = useRef(true);

  useEffect(() => {
    setOpenBranches(new Set());
    setBranchFrom(null);
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
  // Armed branch target — falls back to null (→ composer targets the tip)
  // if the node got deleted out from under the chip.
  const branchFromNode = branchFrom ? (nodes[branchFrom.id] ?? null) : null;
  useEffect(() => {
    if (branchFrom && !nodes[branchFrom.id]) setBranchFrom(null);
  }, [branchFrom, nodes]);

  // Restore the persisted reading position when landing on a session (tab
  // switch / reload / canvas→linear). The anchor alone can't do this: it
  // doesn't move while the user scroll-reads, so anchoring would dump every
  // return at the root card. Declared BEFORE the anchor-scroll effect so the
  // skip flag is armed by the time that effect runs for the same commit.
  const skipAnchorScrollRef = useRef(false);
  useEffect(() => {
    if (!session?.id) return;
    // A streaming tip owns the viewport (bottom-lock) — let it win.
    if (tipStreamingId) return;
    const pos = useSessionStore.getState().readingPosition;
    if (!pos) return;
    const card = roundRefs.current.get(pos.nodeId);
    const container = scrollRef.current;
    if (!card || !container) return; // node left the thread → anchor fallback
    skipAnchorScrollRef.current = true;
    const id = requestAnimationFrame(() => {
      const delta =
        card.getBoundingClientRect().top -
        container.getBoundingClientRect().top;
      container.scrollTop += delta + pos.offset;
    });
    return () => cancelAnimationFrame(id);
    // Snapshot semantics: only re-run when the session changes, not on every
    // node/scroll update within it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  // Anchor navigation → scroll the anchored card into view, top-aligned so
  // the card header (with the question) is what lands in view — centering a
  // card taller than the viewport would drop you mid-answer. Skipped while
  // the anchor IS the streaming tip: the bottom-lock below owns the viewport
  // then.
  useEffect(() => {
    if (skipAnchorScrollRef.current) {
      // The session-landing restore above already positioned the viewport.
      skipAnchorScrollRef.current = false;
      return;
    }
    if (!threadData.anchorId) return;
    if (threadData.anchorId === tipStreamingId) return;
    // Instant jump (no smooth): switching cards in a long thread would
    // otherwise visibly slide through screens of content before settling.
    const id = requestAnimationFrame(() => {
      roundRefs.current
        .get(threadData.anchorId!)
        ?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadData.anchorId]);

  // #6: bottom-lock during streaming. Deltas bypass React (stream-bus), so we
  // subscribe directly and pin scrollTop per animation frame while following.
  useEffect(() => {
    if (!tipStreamingId) return;
    const el = scrollRef.current;
    if (!el) return;
    // 新 tip 开始流式时不无条件抢滚动：只有 tip 就是当前锚点（用户自己发起
    // 的追问会把焦点落在新节点上）、或视口本来就贴底（正在跟读）才开启跟随。
    // 正在上方读旧卡片时，后台启动的运行（CLI 同步轮次等）不把人拽到底部。
    followRef.current =
      threadData.anchorId === tipStreamingId ||
      el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX;
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
    // anchorId is a snapshot at tip-change time: anchor moves mid-stream are
    // handled by onScroll's follow recomputation, not by re-running this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tipStreamingId]);

  // Store-driven growth while streaming (tool-call panel rows, interaction
  // forms) doesn't emit stream deltas — re-pin after those renders too.
  useEffect(() => {
    if (!tipStreamingId || !followRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  // Reading-position tracker: after the scroll settles, record which card
  // straddles the viewport's top edge (and how far into it we are) so tab
  // switches / reloads can land right back there. Debounced — a localStorage
  // write per scroll frame would be noise; the store action also drops stale
  // writes if the session switched while the timer was pending.
  const recordTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (recordTimerRef.current !== null) {
        window.clearTimeout(recordTimerRef.current);
        recordTimerRef.current = null;
      }
    };
  }, [session?.id]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX;

    const sid = session?.id;
    if (!sid) return;
    if (recordTimerRef.current !== null) {
      window.clearTimeout(recordTimerRef.current);
    }
    recordTimerRef.current = window.setTimeout(() => {
      recordTimerRef.current = null;
      const container = scrollRef.current;
      if (!container) return;
      const containerTop = container.getBoundingClientRect().top;
      // Cards are in thread order, tops strictly increasing: the LAST card
      // whose top is at/above the viewport top is the one being read. When
      // every card is below the top (scrolled to the very start), fall back
      // to the first card at offset 0.
      let picked: { nodeId: string; offset: number } | null = null;
      for (const n of threadData.thread) {
        const cardEl = roundRefs.current.get(n.id);
        if (!cardEl) continue;
        const top = cardEl.getBoundingClientRect().top - containerTop;
        if (top <= 1) {
          picked = { nodeId: n.id, offset: Math.max(0, -top) };
        } else {
          if (!picked) picked = { nodeId: n.id, offset: 0 };
          break;
        }
      }
      if (picked) setReadingPosition(sid, picked);
    }, 200);
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
    const state = useSessionStore.getState();
    // 手动标未读的节点不自动回读（unreadHolds）——否则标完未读、卡片还在
    // 视口里，1s 后就被这里标回。timer 回调再查一次，防调度后才标未读。
    if (state.unreadHolds[id]) return;
    const node = state.nodes[id];
    if (!node || node.status !== "done" || node.readAt) return;
    readTimers.current.set(
      id,
      window.setTimeout(() => {
        readTimers.current.delete(id);
        const st = useSessionStore.getState();
        const cur = st.nodes[id];
        if (cur && cur.status === "done" && !cur.readAt && !st.unreadHolds[id])
          void markNodeRead(id);
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
      if (isEditableTarget(e.target)) return;
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
  // Header/cards/composer share one width class so they stay column-aligned.
  const widthClass = THREAD_WIDTH_CLASS[threadWidth];

  return (
    // #3: viewport-bound flex column — header and composer are fixed rails,
    // only the middle scrolls. `sticky bottom-0` was NOT this: with less than
    // a screen of content the composer sat right under the last card,
    // floating mid-screen instead of docked at the bottom.
    <div
      className="fixed inset-0 pt-12 md:pt-[5.25rem] flex flex-col bg-surface-canvas"
      // S1 P1: bottom 让出终端面板的高度。--trellis-term-h 由 TerminalPanel
      // 发布，与 --trellis-sb 同一套模式（一个变量、多个消费者）；面板关闭时
      // 是 0px，等于没这回事。
      style={{
        left: "var(--trellis-sb, 0px)",
        bottom: "var(--trellis-term-h, 0px)",
      }}
    >
      <div className="shrink-0 z-30 border-b border-line/80 bg-surface-canvas/90 backdrop-blur">
        <div className={`${widthClass} mx-auto px-4 py-3 flex items-center gap-3`}>
          <div className="min-w-0 flex-1">
            <div className="text-label uppercase tracking-wide text-ink-faint flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${mode.dot}`} aria-hidden />
              {mode.label} · 线性
            </div>
            <h1 className="truncate text-sm font-semibold text-ink-strong">
              {session.title}
            </h1>
          </div>
          {/* 移动端卡片本就贴满屏宽，宽度切换无意义，藏起来省空间 */}
          <div
            className="hidden md:flex shrink-0 items-center rounded-field border border-line bg-surface p-0.5"
            role="group"
            aria-label="内容宽度"
          >
            {THREAD_WIDTH_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setThreadWidth(opt.value)}
                aria-pressed={threadWidth === opt.value}
                title={`内容宽度：${opt.label}`}
                className={`px-2 py-1 rounded-[calc(var(--radius-field)-2px)] text-xs font-medium transition-colors ${
                  threadWidth === opt.value
                    ? "bg-accent-muted text-accent-ink"
                    : "text-ink-faint hover:text-ink hover:bg-surface-muted"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {isMobile === false && (
            <button
              type="button"
              onClick={() => setViewMode("canvas")}
              className="shrink-0 px-3 py-1.5 rounded-field border border-line bg-surface text-xs font-medium text-ink hover:bg-surface-muted active:scale-95 transition"
            >
              🗺 画布
            </button>
          )}
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-thread-scroll
        className="flex-1 overflow-y-auto"
      >
        <main className={`${widthClass} mx-auto px-4 py-5 pb-6 space-y-4`}>
        {threadData.thread.length === 0 ? (
          <div className="rounded-card border border-dashed border-line-strong bg-surface px-4 py-8 text-center text-sm text-ink-muted">
            暂无节点
          </div>
        ) : (
          threadData.thread.map((node, idx) => {
            const prevNode = idx > 0 ? threadData.thread[idx - 1] : undefined;
            const isCompacted = isContextCompacted(node, prevNode);
            const branches = threadData.branchesByNode.get(node.id) ?? [];
            const isActive = node.id === threadData.anchorId;
            const canDelete =
              session.rootNodeId !== node.id && node.status !== "streaming";
            // Branching from the tip is just "continue" — the composer
            // already does that, so no button there.
            const canBranch =
              node.status !== "streaming" && node.id !== tipNode?.id;
            const isBranchTarget = branchFrom?.id === node.id;
            return (
              <Fragment key={node.id}>
                {isCompacted && (
                  <div
                    className="my-3 py-1 flex items-center gap-3 text-xs select-none"
                    role="separator"
                    aria-label="上下文已自动压缩"
                  >
                    <div className="flex-1 border-t border-dashed border-line-strong/70" />
                    <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface border border-line shadow-raise text-ink-muted text-ui">
                      <span aria-hidden>🗜️</span>
                      <span className="font-medium text-ink-strong">上下文已自动压缩</span>
                      <span className="text-nano text-ink-faint">（早期历史已转入模型紧凑摘要）</span>
                    </div>
                    <div className="flex-1 border-t border-dashed border-line-strong/70" />
                  </div>
                )}
                <section
                  ref={setRoundRef(node.id)}
                  data-thread-node-id={node.id}
                  className={`scroll-mt-3 rounded-card border bg-surface shadow-raise transition-colors ${
                    isActive
                      ? "border-accent-line ring-2 ring-accent-muted"
                      : "border-line"
                  }`}
                >
                <div className="px-4 py-2.5 border-b border-line-faint flex items-center gap-2 text-xs">
                  <span className="font-mono text-ink-faint">
                    #{nodeIndices[node.id] ?? idx + 1}
                  </span>
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      node.status === "streaming"
                        ? "bg-accent animate-pulse"
                        : node.status === "error"
                          ? "bg-danger"
                          : node.readAt
                            ? "bg-line-strong"
                            : "bg-unread"
                    }`}
                  />
                  <span className="text-ink-muted">
                    {node.kind === "reference" ? "Reference" : "Turn"}
                  </span>
                  <div className="ml-auto flex items-center gap-0.5">
                    {node.status === "done" && (
                      <button
                        type="button"
                        onClick={() =>
                          node.readAt
                            ? void markNodeUnread(node.id)
                            : void markNodeRead(node.id)
                        }
                        className={`px-1.5 py-1 rounded-md transition-colors ${
                          node.readAt
                            ? "text-ink-faint hover:bg-unread-muted hover:text-unread-ink"
                            : "text-ink-faint hover:bg-surface-muted hover:text-ink"
                        }`}
                        title={node.readAt ? "标为未读" : "标为已读"}
                        aria-label={node.readAt ? "标为未读" : "标为已读"}
                      >
                        {node.readAt ? (
                          /* 点亮未读点：标为未读 */
                          <svg
                            width="13"
                            height="13"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            aria-hidden
                          >
                            <circle cx="12" cy="12" r="8" />
                            <circle
                              cx="12"
                              cy="12"
                              r="3.5"
                              fill="currentColor"
                              stroke="none"
                            />
                          </svg>
                        ) : (
                          /* 圆内勾：标为已读 */
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
                            <circle cx="12" cy="12" r="8" />
                            <path d="m9 12 2 2 4-4" />
                          </svg>
                        )}
                      </button>
                    )}
                    {canBranch && (
                      <button
                        type="button"
                        onClick={() =>
                          setBranchFrom((prev) => ({
                            id: node.id,
                            n: (prev?.n ?? 0) + 1,
                          }))
                        }
                        className={`px-1.5 py-1 rounded-md transition-colors ${
                          isBranchTarget
                            ? "text-accent bg-accent-muted"
                            : "text-ink-faint hover:bg-accent-muted hover:text-accent"
                        }`}
                        title="从此节点分叉提问"
                        aria-label="从此节点分叉提问"
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
                          <line x1="6" y1="3" x2="6" y2="15" />
                          <circle cx="18" cy="6" r="3" />
                          <circle cx="6" cy="18" r="3" />
                          <path d="M18 9a9 9 0 0 1-9 9" />
                        </svg>
                      </button>
                    )}
                    {canDelete && (
                      <button
                        type="button"
                        onClick={() => confirmDelete(node.id)}
                        className="px-1.5 py-1 rounded-md text-ink-faint hover:bg-danger-muted hover:text-danger transition-colors"
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
                </div>

                <div className="px-4 py-4">
                  <TurnCard node={node} />

                  {branches.length > 0 && (
                    <div className="mt-4 pt-2 border-t border-line-faint">
                      <button
                        type="button"
                        onClick={() => toggleBranches(node.id)}
                        className="text-xs font-medium text-fork-ink/80 hover:text-fork-ink"
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
                              className="w-full text-left px-3 py-2 rounded-card bg-fork-muted border border-fork-line/50 hover:bg-fork-line/25 transition-colors"
                            >
                              <div className="flex items-center gap-2 text-label text-fork-ink/80">
                                <span className="font-mono">
                                  #{nodeIndices[branch.id] ?? "?"}
                                </span>
                                <span>{branch.kind === "reference" ? "reference" : "branch"}</span>
                              </div>
                              <div className="mt-0.5 truncate text-xs text-ink">
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
            </Fragment>
          );
        })
        )}
        </main>
      </div>

      <div className="shrink-0 z-20 border-t border-line/80 bg-surface-canvas/95 backdrop-blur">
        <div className={`${widthClass} mx-auto px-4`}>
          {branchFromNode && (
            <TargetChip
              icon="⑂"
              verb="从"
              suffix="分叉"
              index={nodeIndices[branchFromNode.id] ?? "?"}
              label={branchFromNode.topicLabel ?? truncate(branchFromNode.question, 60)}
              onLabelClick={() =>
                roundRefs.current
                  .get(branchFromNode.id)
                  ?.scrollIntoView({ block: "start" })
              }
              onClear={() => setBranchFrom(null)}
            />
          )}
          <Composer
            targetNode={branchFromNode ?? tipNode}
            placeholder={
              branchFromNode
                ? `从 #${nodeIndices[branchFromNode.id] ?? "?"} 分叉提问…（${sendHint(sendKey)}，Esc 取消）`
                : `继续对话…（${sendHint(sendKey)}，选中文字可 ⌘K 分叉追问）`
            }
            onSubmitted={branchFromNode ? () => setBranchFrom(null) : undefined}
            onEscape={branchFromNode ? () => setBranchFrom(null) : undefined}
            focusToken={branchFrom?.n ?? null}
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
    </div>
  );
}
