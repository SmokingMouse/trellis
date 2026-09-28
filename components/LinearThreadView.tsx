"use client";
import { PendingBar } from "./PendingBar";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { ancestorsOf } from "@/lib/collapsed";
import { isContextCompacted } from "@/lib/context-usage";
import { buildNodeIndex } from "@/lib/node-index";
import { childrenIndex, nodeSort } from "@/lib/tree-panel";
import { subscribeStream } from "@/lib/stream-bus";
import { modeStyle } from "@/lib/mode-style";
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
import { useScrollHide } from "@/hooks/useScrollHide";
import { useVerifyStreamingStub } from "@/hooks/useVerifyStreamingStub";
import { useHerdrFleet } from "@/hooks/useHerdrFleet";
import {
  buildHerdrWorkspaceViews,
  findHerdrPaneForSession,
  isHerdrSession,
} from "@/lib/herdr-ui";
import type { ChatNode } from "@/lib/types";
import { ChevronRight, GitBranch, Layers, Workflow, X } from "lucide-react";
import {
  Button,
  Icon,
  IconButton,
  SegmentedControl,
  StatusDot,
} from "@/components/ui";
import { BranchPopover } from "./BranchPopover";
import { Composer } from "./Composer";
import { TurnCard } from "./TurnCard";
import {
  HerdrComposer,
  HerdrOfflineBanner,
  HerdrSessionBadge,
} from "./HerdrSessionControls";
import { HerdrInteractionCard } from "./HerdrInteractionCard";

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

export function LinearThreadView({ isMobile }: { isMobile: boolean }) {
  const session = useSessionStore((s) => s.session);
  const nodes = useSessionStore((s) => s.nodes);
  const activeNodeId = useSessionStore((s) => s.activeNodeId);
  const setActiveNode = useSessionStore((s) => s.setActiveNode);
  const setReadingPosition = useSessionStore((s) => s.setReadingPosition);
  const setViewMode = useSessionStore((s) => s.setViewMode);
  const markNodeRead = useSessionStore((s) => s.markNodeRead);
  const jumpToParentAtAnchor = useSessionStore((s) => s.jumpToParentAtAnchor);
  const threadWidth = useSessionStore((s) => s.threadWidth);
  const setThreadWidth = useSessionStore((s) => s.setThreadWidth);
  const herdrSnapshot = useHerdrFleet();
  const herdrWorkspaces = useMemo(
    () =>
      buildHerdrWorkspaceViews(
        herdrSnapshot.fleet,
        herdrSnapshot.hooks,
      ),
    [herdrSnapshot.fleet, herdrSnapshot.hooks],
  );
  const herdrPane = useMemo(
    () =>
      findHerdrPaneForSession(
        herdrSnapshot.fleet,
        herdrSnapshot.hooks,
        herdrWorkspaces,
        session?.id,
      ),
    [
      herdrSnapshot.fleet,
      herdrSnapshot.hooks,
      herdrWorkspaces,
      session?.id,
    ],
  );
  const isHerdr = isHerdrSession(session, herdrSnapshot.fleet);
  const confirmDelete = useConfirmDelete();
  const nodeIndices = useMemo(() => buildNodeIndex(nodes), [nodes]);
  const [openBranches, setOpenBranches] = useState<Set<string>>(new Set());
  // Retargets the bottom composer at an intermediate node (reply-to style):
  // the ⑂ button on a card arms it, submit/Esc/✕ disarm it. `n` is a nonce so
  // re-clicking the same card re-pulls focus into the composer.
  const [branchFrom, setBranchFrom] = useState<{ id: string; n: number } | null>(
    null,
  );
  // 稳定引用：TurnCard 是 memo 组件，回调换引用会让所有轮次跟着重渲。
  const armBranch = useCallback((id: string) => {
    setBranchFrom((prev) => ({ id, n: (prev?.n ?? 0) + 1 }));
  }, []);
  const roundRefs = useRef(new Map<string, HTMLDivElement>());
  const scrollRef = useRef<HTMLDivElement>(null);
  // #6: sticky-to-bottom while the tip streams. True = keep pinning the
  // viewport to the bottom on new content; flips off when the user scrolls
  // up past FOLLOW_SLACK_PX, back on when they return to the bottom.
  const followRef = useRef(true);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const {
    isHidden: scrollHidden,
    reveal: revealScrollChrome,
    updateFromScroll,
  } = useScrollHide({ enabled: isMobile, resetKey: session?.id, scrollRef });
  useVerifyStreamingStub(isMobile, session?.id);

  useEffect(() => {
    setOpenBranches(new Set());
    setBranchFrom(null);
    setComposerExpanded(false);
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

  const waitingNodes = useMemo(
    () => Object.values(nodes).filter((node) => node.pendingInteraction).sort(nodeSort),
    [nodes],
  );

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

  const pendingNavigation = useSessionStore(s => s.pendingNavigation);
  useEffect(() => {
    if (!pendingNavigation) return;
    const frame = requestAnimationFrame(() => {
      const card = roundRefs.current.get(pendingNavigation.nodeId)?.querySelector<HTMLElement>("[data-mobile-interaction]");
      if (!card) return;
      card.scrollIntoView({ block: "start" });
      card.tabIndex = -1;
      card.focus({ preventScroll: true });
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        card.animate([{ boxShadow: "0 0 0 3px var(--accent)" }, { boxShadow: "0 0 0 0px transparent" }], { duration: 1800 });
      }
      useSessionStore.setState({ pendingNavigation: null });
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingNavigation, threadData.anchorId]);

  // Restore the persisted reading position when landing on a session (tab
  // switch / reload / canvas→linear). The anchor alone can't do this: it
  // doesn't move while the user scroll-reads, so anchoring would dump every
  // return at the root card. Declared BEFORE the anchor-scroll effect so the
  // skip flag is armed by the time that effect runs for the same commit.
  const skipAnchorScrollRef = useRef(false);
  const mapNavigation = useSessionStore(s => s.mapNavigation);
  const [mapHighlight, setMapHighlight] = useState<string | null>(null);
  useEffect(() => {
    if (!mapNavigation) return;
    const frame = requestAnimationFrame(() => {
      const card = roundRefs.current.get(mapNavigation.nodeId);
      if (!card) return;
      card.scrollIntoView({ block: "start" });
      card.focus({ preventScroll: true });
      setMapHighlight(mapNavigation.nodeId);
    });
    const timer = window.setTimeout(() => {
      setMapHighlight(null);
      if (useSessionStore.getState().mapNavigation === mapNavigation) useSessionStore.setState({ mapNavigation: null });
    }, 2200);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [mapNavigation]);
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

    updateFromScroll(el.scrollTop, followRef.current);

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

  const onComposerExpandedChange = useCallback((expanded: boolean) => {
    setComposerExpanded(expanded);
    if (expanded) revealScrollChrome();
  }, [revealScrollChrome]);

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
  const composerIsHidden =
    isMobile &&
    scrollHidden &&
    waitingNodes.length === 0 &&
    !isHerdr &&
    !tipStreamingId &&
    !composerExpanded;
  const mobileHeaderHidden = isMobile && scrollHidden;
  const revealFromHiddenTitleArea = (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    if (!mobileHeaderHidden) return;
    const safeTop =
      Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--safe-top",
        ),
      ) || 0;
    const titleHeight =
      document
        .querySelector<HTMLElement>("[data-thread-header]")
        ?.getBoundingClientRect().height ?? 56;
    if (event.clientY <= safeTop + titleHeight) revealScrollChrome();
  };

  return (
    // #3: viewport-bound flex column — header and composer are fixed rails,
    // only the middle scrolls. `sticky bottom-0` was NOT this: with less than
    // a screen of content the composer sat right under the last card,
    // floating mid-screen instead of docked at the bottom.
    <div
      data-safe-area="linear-thread"
      className="fixed inset-0 pt-[var(--trellis-header-h)] md:pt-[5.25rem] flex flex-col bg-surface-canvas"
      data-active-session-id={session?.id}
      data-active-node-id={activeNodeId ?? ""}
      // S1 P1: bottom 让出终端面板的高度。--trellis-term-h 由 TerminalPanel
      // 发布，与 --trellis-sb 同一套模式（一个变量、多个消费者）；面板关闭时
      // 是 0px，等于没这回事。
      style={{
        left: "var(--trellis-sb, 0px)",
        bottom: "var(--trellis-term-h, 0px)",
        paddingTop: isMobile ? undefined : "calc(5.25rem + var(--trellis-pending-h, 0px))",
      }}
    >
      <div
        data-thread-header
        data-thread-header-hidden={mobileHeaderHidden ? "true" : undefined}
        aria-hidden={mobileHeaderHidden ? true : undefined}
        inert={mobileHeaderHidden ? true : undefined}
        className="shrink-0 z-30 max-md:h-14 border-b border-line/80 bg-surface-canvas/90 backdrop-blur transition-transform duration-200 motion-reduce:transition-none"
        style={{
          transform: mobileHeaderHidden
            ? "translateY(calc(-100% - var(--trellis-header-h)))"
            : undefined,
        }}
      >
        <div className={`${widthClass} mx-auto px-4 py-2 max-md:h-full flex items-center gap-3`}>
          <div className="min-w-0 flex-1">
            {isHerdr ? (
              <HerdrSessionBadge
                pane={herdrPane}
                loading={herdrSnapshot.loading}
              />
            ) : (
              <div className="text-label text-ink-faint flex items-center gap-1.5">
                <StatusDot tone={session.mode === "project" ? "project" : "chat"} />
                {mode.label} · 线性
              </div>
            )}
            <h1 className="truncate text-ui font-semibold text-ink-strong">
              {session.title}
            </h1>
          </div>
          {/* 移动端卡片本就贴满屏宽，宽度切换无意义，藏起来省空间 */}
          <SegmentedControl
            size="sm"
            aria-label="内容宽度"
            value={threadWidth}
            onValueChange={setThreadWidth}
            options={THREAD_WIDTH_OPTIONS.map((opt) => ({
              value: opt.value,
              label: opt.label,
              title: `内容宽度：${opt.label}`,
            }))}
            className="hidden md:inline-flex shrink-0"
          />
          {!isMobile && !isHerdr && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setViewMode("canvas")}
              data-map-open
              className="shrink-0"
            >
              <Icon icon={Workflow} size="sm" />
              画布
            </Button>
          )}
        </div>
      </div>

      {isMobile && <PendingBar mobile hiddenChrome={mobileHeaderHidden} />}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        onClick={revealFromHiddenTitleArea}
        data-thread-scroll
        className="flex-1 overflow-y-auto"
        style={
          mobileHeaderHidden
            ? {
                marginBottom:
                  "calc(var(--safe-top) - var(--trellis-header-h) - 3.5rem)",
                transform:
                  "translateY(calc(var(--safe-top) - var(--trellis-header-h) - 3.5rem))",
              }
            : isMobile
              ? undefined
              : // 树浮窗展开时右侧让出安全区（TreePanel 发布 --trellis-tree-safe），
                // 正文列在剩余宽度里居中，不再被浮窗压住。
                { paddingRight: "var(--trellis-tree-safe, 0px)" }
        }
      >
        <main className={`${widthClass} mx-auto px-4 md:px-8 py-4 pb-6 max-md:pb-28`}>
        {isHerdr && herdrPane && (
          <HerdrInteractionCard pane={herdrPane} />
        )}
        {isHerdr && session && (
          <HerdrOfflineBanner
            sessionId={session.id}
            pane={herdrPane}
            loading={herdrSnapshot.loading}
          />
        )}
        {threadData.thread.length === 0 ? (
          <div className="rounded-card border border-dashed border-line-strong px-4 py-8 text-center text-ui text-ink-muted">
            {session.origin === "external" ? session.externalStatus === "closed" ? "外部线程已结束" : "外部线程已收编，可在下方提问" : "暂无节点"}
          </div>
        ) : (
          threadData.thread.map((node, idx) => {
            const prevNode = idx > 0 ? threadData.thread[idx - 1] : undefined;
            const isCompacted = isContextCompacted(node, prevNode);
            const branches = threadData.branchesByNode.get(node.id) ?? [];
            const isActive = node.id === threadData.anchorId;
            const canDelete =
              !isHerdr &&
              session.rootNodeId !== node.id &&
              node.status !== "streaming";
            // Branching from the tip is just "continue" — the composer
            // already does that, so no button there.
            const canBranch =
              !isHerdr &&
              node.status !== "streaming" &&
              node.id !== tipNode?.id;
            const isBranchTarget = branchFrom?.id === node.id;
            return (
              <Fragment key={node.id}>
                {isCompacted && (
                  <div
                    className="mt-6 mb-1 flex items-center gap-3 text-label text-ink-faint select-none"
                    role="separator"
                    aria-label="上下文已自动压缩"
                  >
                    <div className="flex-1 border-t border-line" />
                    <span className="inline-flex items-center gap-1.5">
                      <Icon icon={Layers} size="sm" />
                      上下文已自动压缩 · 早期历史已转为摘要
                    </span>
                    <div className="flex-1 border-t border-line" />
                  </div>
                )}
                <section
                  ref={setRoundRef(node.id)}
                  data-thread-node-id={node.id}
                  data-map-highlight={mapHighlight === node.id || undefined}
                  tabIndex={-1}
                  style={mapHighlight === node.id ? { outline: "3px solid var(--color-accent-ink)", outlineOffset: 3 } : undefined}
                  data-thread-active={isActive || undefined}
                  className="group/turn scroll-mt-3 py-4 outline-none"
                >
                  <TurnCard
                    node={node}
                    readOnly={isHerdr}
                    index={nodeIndices[node.id] ?? idx + 1}
                    isActive={isActive}
                    canBranch={canBranch}
                    branchArmed={isBranchTarget}
                    onBranch={armBranch}
                    canDelete={canDelete}
                    onDelete={confirmDelete}
                  />

                  {branches.length > 0 && (
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={() => toggleBranches(node.id)}
                        aria-expanded={openBranches.has(node.id)}
                        className="-ml-1.5 inline-flex items-center gap-1.5 min-h-6.5 px-1.5 rounded-field text-label font-medium text-fork-ink hover:bg-fork-muted transition-colors max-md:min-h-11"
                      >
                        <Icon icon={GitBranch} size="sm" className="text-fork" />
                        {branches.length} 个分支
                        <Icon
                          icon={ChevronRight}
                          size="sm"
                          className={`text-ink-faint transition-transform motion-reduce:transition-none ${
                            openBranches.has(node.id) ? "rotate-90" : ""
                          }`}
                        />
                      </button>
                      {openBranches.has(node.id) && (
                        <div className="mt-1.5 ml-2 pl-3 border-l border-fork-line space-y-0.5">
                          {branches.map((branch) => (
                            <button
                              key={branch.id}
                              type="button"
                              onClick={() => setActiveNode(branch.id)}
                              className="w-full flex items-baseline gap-2 text-left min-h-8 px-2 py-1.5 rounded-field hover:bg-surface-hover transition-colors max-md:min-h-11"
                            >
                              <span className="shrink-0 font-mono text-nano text-ink-faint">
                                #{nodeIndices[branch.id] ?? "?"}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-ui text-ink">
                                {branch.topicLabel ?? truncate(branch.question, 120)}
                              </span>
                              <span className="shrink-0 text-nano text-ink-faint">
                                {branch.kind === "reference" ? "参考材料" : "分支"}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
              </section>
            </Fragment>
          );
        })
        )}
        </main>
      </div>

      <div
        data-safe-area="linear-composer"
        data-composer-hidden={composerIsHidden ? "true" : "false"}
        className={`shrink-0 z-20 bg-surface-canvas/95 transition-transform duration-200 motion-reduce:transition-none max-md:absolute max-md:inset-x-0 max-md:bottom-0 max-md:border-t max-md:border-line max-md:backdrop-blur ${
          composerIsHidden ? "max-md:translate-y-full max-md:pointer-events-none" : "translate-y-0"
        }`}
        style={{
          paddingBottom: "var(--safe-bottom)",
          paddingRight: isMobile ? undefined : "var(--trellis-tree-safe, 0px)",
        }}
      >
        <div className={`${widthClass} mx-auto px-4 md:px-8`}>
          {isHerdr ? (
            herdrPane?.alive ? <HerdrComposer pane={herdrPane} /> : null
          ) : (
            <Composer
              targetNode={branchFromNode ?? tipNode}
              targetIndex={
                (branchFromNode ?? tipNode)
                  ? nodeIndices[(branchFromNode ?? tipNode)!.id]
                  : undefined
              }
              fork={!!branchFromNode}
              mobileCompact={isMobile}
              onMobileExpandedChange={onComposerExpandedChange}
              banner={
                branchFromNode ? (
                  <div
                    data-composer-fork-target=""
                    className="flex items-center gap-2 mx-1.5 mt-1.5 pl-2.5 pr-1 min-h-8 rounded-field bg-fork-muted text-ui text-fork-ink"
                  >
                    <Icon icon={GitBranch} size="sm" className="text-fork" />
                    <button
                      type="button"
                      onClick={() =>
                        roundRefs.current
                          .get(branchFromNode.id)
                          ?.scrollIntoView({ block: "start" })
                      }
                      className="min-w-0 flex-1 truncate text-left hover:underline"
                      title="定位到该节点"
                    >
                      从{" "}
                      <span className="font-mono tabular-nums">
                        #{nodeIndices[branchFromNode.id] ?? "?"}
                      </span>{" "}
                      分叉 ·{" "}
                      <span className="text-ink">
                        {branchFromNode.topicLabel ?? truncate(branchFromNode.question, 60)}
                      </span>
                    </button>
                    <IconButton
                      size="sm"
                      label="取消分叉"
                      shortcut="Esc"
                      onClick={() => setBranchFrom(null)}
                    >
                      <Icon icon={X} size="sm" />
                    </IconButton>
                  </div>
                ) : undefined
              }
              placeholder={
                branchFromNode
                  ? `从 #${nodeIndices[branchFromNode.id] ?? "?"} 分叉提问…`
                  : "继续对话…  输入 / 调出命令，选中正文可分叉追问"
              }
              onSubmitted={branchFromNode ? () => setBranchFrom(null) : undefined}
              onEscape={branchFromNode ? () => setBranchFrom(null) : undefined}
              focusToken={branchFrom?.n ?? null}
            />
          )}
        </div>
      </div>

      {!isHerdr && popover?.selection && (
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
