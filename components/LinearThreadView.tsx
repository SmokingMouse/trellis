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
import { createPortal } from "react-dom";
import { isOptimisticNodeId, useSessionStore } from "@/stores/sessionStore";
import { useComposerInsertStore } from "@/stores/composerInsertStore";
import { ancestorsOf } from "@/lib/collapsed";
import { isContextCompacted } from "@/lib/context-usage";
import { buildNodeIndex } from "@/lib/node-index";
import { childrenIndex, nodeSort } from "@/lib/tree-panel";
import { subscribeStream } from "@/lib/stream-bus";
import {
  THREAD_WIDTH_CLASS,
  THREAD_WIDTH_OPTIONS,
  treeSafePadding,
} from "@/lib/thread-width";
import { isEditableTarget } from "@/lib/shortcuts";
import {
  useSelectionWithin,
  type SelectionInfo,
} from "@/hooks/useSelectionWithin";
import { useConfirmDelete } from "@/hooks/useConfirmDelete";
import { useScrollHide } from "@/hooks/useScrollHide";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import { useVerifyStreamingStub } from "@/hooks/useVerifyStreamingStub";
import { useHerdrFleet } from "@/hooks/useHerdrFleet";
import {
  buildHerdrWorkspaceViews,
  findHerdrPaneForSession,
  herdrRunLabel,
  isHerdrSession,
} from "@/lib/herdr-ui";
import type { ChatNode } from "@/lib/types";
import { ArrowDown, ChevronRight, GitBranch, Layers, MessageSquareDashed, Workflow, X } from "lucide-react";
import {
  Button,
  Icon,
  IconButton,
  SegmentedControl,
  StatusDot,
} from "@/components/ui";
import { Collapse } from "@/components/ui/Collapse";
import { EmptyState } from "@/components/ui/EmptyState";
import { BranchPopover } from "./BranchPopover";
import { Composer } from "./Composer";
import { TurnCard } from "./TurnCard";
import {
  HerdrComposer,
  HerdrOfflineBanner,
  HerdrSessionBadge,
} from "./HerdrSessionControls";
import { HerdrInteractionCard } from "./HerdrInteractionCard";
import { HerdrDrawerToggle } from "./herdr/HerdrDrawerToggle";
import { HerdrSessionGestures, HerdrSessionSwipeCard } from "./herdr/HerdrSessionGestures";
import { ButlerChangeCards } from "./ButlerChangeCards";
import { isButlerSession } from "@/lib/butler";

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

/**
 * 线性 Thread 沿树下行时的子节点择优：
 * 优先走「有输出、非空」的分支，且优先走「子树更深/更活跃」的主干；
 * 避免因为用户中途取消重输产生空壳 sibling: 0 而把主线带入死胡同。
 */
function preferredChild(
  children: ChatNode[] | undefined,
  byParent: Map<string, ChatNode[]>,
): ChatNode | undefined {
  if (!children || children.length === 0) return undefined;
  if (children.length === 1) return children[0];

  const subtreeDepth = (id: string, depth = 0): number => {
    if (depth > 50) return depth;
    const kids = byParent.get(id);
    if (!kids || kids.length === 0) return depth;
    let maxSub = depth;
    for (const k of kids) {
      const d = subtreeDepth(k.id, depth + 1);
      if (d > maxSub) maxSub = d;
    }
    return maxSub;
  };

  const isUsable = (n: ChatNode) =>
    Boolean(n.response?.trim()) ||
    n.toolCalls.length > 0 ||
    (n.toolCallStats?.total ?? 0) > 0 ||
    n.status === "streaming";

  let best = children[0];
  let bestUsable = isUsable(best);
  let bestDepth = subtreeDepth(best.id);

  for (let i = 1; i < children.length; i++) {
    const candidate = children[i];
    const candidateUsable = isUsable(candidate);
    const candidateDepth = subtreeDepth(candidate.id);

    // 1. 有内容优先于空壳
    if (candidateUsable && !bestUsable) {
      best = candidate;
      bestUsable = true;
      bestDepth = candidateDepth;
      continue;
    }
    if (!candidateUsable && bestUsable) continue;

    // 2. 深度更深（更有后续）优先
    if (candidateDepth > bestDepth) {
      best = candidate;
      bestUsable = candidateUsable;
      bestDepth = candidateDepth;
      continue;
    }
    if (candidateDepth < bestDepth) continue;

    // 3. 深度相同时，遵从 nodeSort 默认顺序（siblingIndex / createdAt）
  }

  return best;
}

function firstRoot(nodes: Record<string, ChatNode>, rootNodeId?: string | null) {
  if (rootNodeId && nodes[rootNodeId]) return nodes[rootNodeId];
  return Object.values(nodes)
    .filter((n) => !n.parentId)
    .sort(nodeSort)[0] ?? null;
}

/**
 * 线性 thread 当前展示的那条分支的叶节点 id（与下面 threadData 同一套择路：锚点 →
 * preferredChild 一路向下）。会话接力用它决定「导出到哪一轮为止」。乐观节点（还没
 * 落库）跳过，退回最近的已落库祖先；一个都没有返回 null（服务端退回最近节点）。
 */
export function visibleThreadLeafId(
  nodes: Record<string, ChatNode>,
  activeNodeId: string | null,
  rootNodeId?: string | null,
): string | null {
  const anchor = activeNodeId && nodes[activeNodeId] ? nodes[activeNodeId] : firstRoot(nodes, rootNodeId);
  if (!anchor) return null;
  const byParent = childrenIndex(nodes);
  let cur: ChatNode = anchor;
  for (let i = 0; i < 5000; i++) {
    const child = preferredChild(byParent.get(cur.id), byParent);
    if (!child) break;
    cur = child;
  }
  let leaf: ChatNode | undefined = cur;
  while (leaf && isOptimisticNodeId(leaf.id)) leaf = leaf.parentId ? nodes[leaf.parentId] : undefined;
  return leaf?.id ?? null;
}

// How close to the bottom (px) still counts as "following" — scrolling
// further up than this pauses the stream auto-follow until the user returns.
const FOLLOW_SLACK_PX = 120;
// 离底超过这么远才出「回到底部」浮钮：刚好在跟随阈值外一点点时不打扰。
const JUMP_TO_BOTTOM_PX = 480;

// 用户发送后滚到底的平滑滚动时长（锁住期间流式跟随不直接写 scrollTop）。
const SEND_SMOOTH_MS = 450;

// 空会话（已收编、还没有轮次的外部线程）的起手句：点了填进输入框，不替用户发。
const STARTER_PROMPTS = [
  "总结一下这个线程目前的进展",
  "列出接下来还要做的事",
  "检查工作区有没有未提交的改动",
];

// 新轮次入场（上浮 6px 淡入，--dur-base / --ease-out）只给「挂载后新出现」的轮次：
//   - 切进会话那一刻已有的节点全是历史，记为不播；
//   - 一次冒出多个新节点（缓存 → 网络补齐、外部同步一批）也按历史处理；
//   - 乐观占位换成服务端真节点（同 parent 刚有过 optimistic-*）：section 的 key 变了
//     会重挂，真节点接着占位那段动画的进度播完（continue），不从头再闪一次。
// 判定在渲染期一次定下并记住（同 Composer 草稿的渲染期 setState 写法）；动画本身在
// section 的 ref 回调里用 WAAPI 起（要拿到「占位已经播了多久」接着播）。
type TurnEnterKind = "enter" | "continue";
type TurnEnterInfo = { kind: TurnEnterKind; parentId: string | null };
const TURN_ENTER_MS = 200;

function useEnteringTurns(
  sessionId: string | null,
  nodes: Record<string, ChatNode>,
  thread: ChatNode[],
): ReadonlyMap<string, TurnEnterInfo> {
  const [track, setTrack] = useState<{
    sid: string | null;
    seen: Map<string, string | null>;
    entering: Map<string, TurnEnterInfo>;
  }>(() => ({ sid: null, seen: new Map(), entering: new Map() }));
  if (track.sid !== sessionId) {
    const seen = new Map<string, string | null>();
    for (const n of Object.values(nodes)) seen.set(n.id, n.parentId);
    setTrack({ sid: sessionId, seen, entering: new Map() });
  } else {
    const fresh = thread.filter((n) => !track.seen.has(n.id));
    if (fresh.length > 0) {
      const seen = new Map(track.seen);
      const entering = new Map(track.entering);
      for (const n of fresh) {
        seen.set(n.id, n.parentId);
        if (fresh.length !== 1) continue;
        const replacesOptimistic =
          !isOptimisticNodeId(n.id) &&
          [...track.entering].some(
            ([id, v]) => isOptimisticNodeId(id) && v.parentId === n.parentId,
          );
        entering.set(n.id, { kind: replacesOptimistic ? "continue" : "enter", parentId: n.parentId });
      }
      setTrack({ sid: sessionId, seen, entering });
    }
  }
  return track.entering;
}

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
  // SessionTabs 渲染 #trellis-tab-actions 占位；它先于本组件挂载，所以 effect 里一定取得到。
  const [tabActionsSlot, setTabActionsSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTabActionsSlot(document.getElementById("trellis-tab-actions"));
  }, []);
  const butler = isButlerSession(session);
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
  // Herdr 会话的手机手势（左右滑切窗格 / 顶部下拉开终端）只位移正文列，不碰滚动容器自身的 transform。
  const gestureContentRef = useRef<HTMLElement>(null);
  // #6: sticky-to-bottom while the tip streams. True = keep pinning the
  // viewport to the bottom on new content; flips off when the user scrolls
  // up past FOLLOW_SLACK_PX, back on when they return to the bottom.
  const followRef = useRef(true);
  // 用户自己发送后的那一下平滑滚到底：锁到这个时间点（performance.now()）为止。
  // 锁住期间流式跟随不直接写 scrollTop（会把平滑滚动打断在半路），onScroll 也
  // 强制顶栏可见——useScrollHide 收起顶栏时回写 scrollTop 同样会打断它（见 jumpToBottom）。
  const smoothUntilRef = useRef(0);
  // 锁到期的那次补贴底。不随流式 effect 清理：乐观占位换成真节点时 effect 会重跑，
  // 这一下仍然要落地（否则平滑途中长出来的内容会留在视口下面）。
  const smoothSettleRef = useRef(0);
  useEffect(() => () => window.clearTimeout(smoothSettleRef.current), []);
  const [composerExpanded, setComposerExpanded] = useState(false);
  // 参考 Codex 手机端：读旧内容时右下角一个「回到底部」浮钮，生成中顺带提示。
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const keyboard = useKeyboardInset(isMobile);
  // 输入框实测高度：正文底部留白和浮钮位置都跟着它走，而不是写死 pb-28——
  // 展开态（分叉横幅 + 附件 + 160px 输入区 + 工具栏）会超过固定值盖住最后一段。
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  useEffect(() => {
    const el = composerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      setComposerHeight(Math.round(el.getBoundingClientRect().height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
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
      const child: ChatNode | undefined = preferredChild(byParent.get(cur.id), byParent);
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

  const entering = useEnteringTurns(session?.id ?? null, nodes, threadData.thread);

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
  // Herdr 镜像的最后一轮：库里是 done，运行态看窗格（S184 hook 驱动）。
  const mirrorRunLabel = isHerdr ? herdrRunLabel(herdrPane) : null;
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

  // Landing on a session (tab switch / reload / canvas→linear) positions the
  // viewport itself (see the land-at-bottom effect below), so the anchor-scroll
  // effect must stand down for that commit. Declared BEFORE the anchor-scroll
  // effect so the skip flag is armed by the time that effect runs.
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
  // 2026-09-30 用户要求：进入标签（新开 / 切回 / 刷新）一律落到最底部，取代
  // 「恢复上次阅读位置」。显式跳转（地图点节点、通知 / 待办定位）自己定位，这里让路。
  // 内容会在首帧之后继续长高（markdown、图片、懒加载），所以短时间内跟着贴底，
  // 用户一滚动 / 触摸 / 按键就立刻放手。
  useEffect(() => {
    if (!session?.id) return;
    const { pendingNavigation: pending, mapNavigation: mapNav } = useSessionStore.getState();
    if (pending || mapNav) return;
    const container = scrollRef.current;
    if (!container) return;
    skipAnchorScrollRef.current = true;
    followRef.current = true;
    let done = false;
    const pin = () => {
      if (!done) container.scrollTop = container.scrollHeight;
    };
    const frame = requestAnimationFrame(() => {
      // 同一提交里的锚点滚动已被跳过；锚点没变时 flag 不会被消费，这里兜底复位。
      skipAnchorScrollRef.current = false;
      pin();
    });
    const resize = new ResizeObserver(pin);
    if (container.firstElementChild) resize.observe(container.firstElementChild);
    const release = () => {
      done = true;
      resize.disconnect();
    };
    const timer = window.setTimeout(release, 1500);
    const userEvents = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    for (const type of userEvents) container.addEventListener(type, release, { passive: true, once: true });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      release();
      for (const type of userEvents) container.removeEventListener(type, release);
    };
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
    // 发送后的平滑滚动还在途（乐观占位换真节点时会重跑到这里）：跟随不能被半路的
    // 距离判定关掉。
    followRef.current =
      performance.now() < smoothUntilRef.current ||
      threadData.anchorId === tipStreamingId ||
      el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX;
    let raf = 0;
    const pin = () => {
      raf = 0;
      if (performance.now() < smoothUntilRef.current) {
        // 平滑途中内容又长了：重新瞄准底部（浏览器会把进行中的平滑滚动平滑改道），
        // 不直接写 scrollTop 打断它。
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
        return;
      }
      if (followRef.current && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    };
    // 用户刚发出的这一轮（锚点就是乐观占位）且离底部还有一段：平滑滚过去，
    // 之后的流式跟随照旧直接写 scrollTop（逐帧平滑会抖）。
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const ownSend = threadData.anchorId === tipStreamingId && isOptimisticNodeId(tipStreamingId);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const releaseSmooth = () => {
      smoothUntilRef.current = 0;
    };
    if (ownSend && distance > 1 && !reduced) {
      // 隔着好几屏时先瞬移到离底一屏半，平滑只走最后一段。
      if (distance > el.clientHeight * 3) el.scrollTop = el.scrollHeight - el.clientHeight * 2.5;
      smoothUntilRef.current = performance.now() + SEND_SMOOTH_MS;
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      // 锁到期补一次贴底：平滑途中内容可能又长高了。
      window.clearTimeout(smoothSettleRef.current);
      smoothSettleRef.current = window.setTimeout(() => {
        // 用户中途动过手（releaseSmooth 已清零）就不再强拉。
        if (smoothUntilRef.current === 0) return;
        smoothUntilRef.current = 0;
        followRef.current = true;
        const box = scrollRef.current;
        if (box) box.scrollTop = box.scrollHeight;
      }, SEND_SMOOTH_MS + 20);
      // 用户中途自己动手：立刻放锁，交还给 onScroll 的跟随判定。
      el.addEventListener("wheel", releaseSmooth, { passive: true, once: true });
      el.addEventListener("touchstart", releaseSmooth, { passive: true, once: true });
    } else {
      pin();
    }
    const unsub = subscribeStream(tipStreamingId, () => {
      if (!raf) raf = requestAnimationFrame(pin);
    });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener("wheel", releaseSmooth);
      el.removeEventListener("touchstart", releaseSmooth);
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
    if (performance.now() < smoothUntilRef.current) return;
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
    if (performance.now() < smoothUntilRef.current) {
      // 发送后的平滑滚动途中：保持跟随、顶栏不收（见 smoothUntilRef）。
      followRef.current = true;
      setAwayFromBottom(false);
      updateFromScroll(el.scrollTop, true);
      return;
    }
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    followRef.current = distance < FOLLOW_SLACK_PX;
    setAwayFromBottom(distance > JUMP_TO_BOTTOM_PX);

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

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    // 先放出顶栏 / 输入框：reveal 会改写 scrollTop，放在滚动之后会打断平滑滚动。
    revealScrollChrome();
    followRef.current = true;
    setAwayFromBottom(false);
    // 直接跳，不用 smooth：下滑会触发 useScrollHide 收起顶栏并回写 scrollTop，
    // 把进行中的平滑滚动打断在半路（实测停在离底 1000+px）；隔几十屏平滑也只是晃。
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
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

  // 入场动画：每个 section 元素只播一次（ref 回调每次渲染都会重绑）。乐观占位起播的
  // Animation 按 parent 记下，换成真节点时读它的 currentTime，从同一进度接着播。
  const animatedEls = useRef(new WeakSet<HTMLElement>());
  const optimisticEnter = useRef(new Map<string, Animation>());
  const playTurnEnter = (id: string, el: HTMLElement) => {
    if (animatedEls.current.has(el)) return;
    animatedEls.current.add(el);
    const info = entering.get(id);
    if (!info || typeof el.animate !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const parentKey = info.parentId ?? "";
    let elapsed = 0;
    if (info.kind === "continue") {
      const prev = optimisticEnter.current.get(parentKey);
      optimisticEnter.current.delete(parentKey);
      elapsed = Number(prev?.currentTime ?? TURN_ENTER_MS);
      if (!(elapsed < TURN_ENTER_MS)) return;
    }
    const anim = el.animate(
      [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: TURN_ENTER_MS, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "backwards" },
    );
    anim.currentTime = elapsed;
    if (info.kind === "enter" && isOptimisticNodeId(id)) optimisticEnter.current.set(parentKey, anim);
  };

  const setRoundRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) {
      roundRefs.current.set(id, el);
      observerRef.current?.observe(el);
      playTurnEnter(id, el);
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
    // 收起后顶栏原先占的那条（48px）仍可点回
    if (event.clientY <= safeTop + 48) revealScrollChrome();
  };

  return (
    // #3: viewport-bound flex column — header and composer are fixed rails,
    // only the middle scrolls. `sticky bottom-0` was NOT this: with less than
    // a screen of content the composer sat right under the last card,
    // floating mid-screen instead of docked at the bottom.
    <div
      data-safe-area="linear-thread"
      className="fixed inset-0 pt-[var(--trellis-header-h)] md:pt-[5.25rem] flex flex-col bg-surface-canvas md:bg-surface"
      data-active-session-id={session?.id}
      data-active-node-id={activeNodeId ?? ""}
      // S1 P1: bottom 让出终端面板的高度。--trellis-term-h 由 TerminalPanel
      // 发布，与 --trellis-sb 同一套模式（一个变量、多个消费者）；面板关闭时
      // 是 0px，等于没这回事。
      style={{
        left: "var(--trellis-sb, 0px)",
        // 管家右栏（ButlerPanel 发布 --trellis-rp）；其余会话恒为 0。
        right: "calc(var(--trellis-rp, 0px) + var(--trellis-herdr-dw, 0px))",
        // 软键盘弹起：整列钉在键盘之上的可见区域（useKeyboardInset）。
        top: keyboard.open ? keyboard.top : undefined,
        bottom: keyboard.open
          ? `max(var(--trellis-term-h, 0px), ${keyboard.bottom}px)`
          : "var(--trellis-term-h, 0px)",
        ["--trellis-composer-h" as string]: composerHeight ? `${composerHeight}px` : undefined,
        paddingTop: isMobile ? undefined : "calc(5.25rem + var(--trellis-pending-h, 0px))",
      }}
    >
      {/* 手机线程头（原 56px「模式 · 线性」+ 标题）已并进全局 Header（components/Header.tsx
          手机分支的标题 + 副标题），这里不再渲染第二层顶栏。桌面端本来就不显示它。 */}

      {/* 桌面端：标题已在面包屑和标签里，不再单独占一行；Herdr 标识、宽度切换、
          画布入口收进标签条右端（照 mockups/01-workbench.html），和正文列不再错位。 */}
      {!isMobile &&
        tabActionsSlot &&
        createPortal(
          <div data-thread-actions className="flex min-w-0 items-center gap-2">
            {isHerdr && (
              <div className="min-w-0 max-w-80">
                <HerdrSessionBadge
                  pane={herdrPane}
                  loading={herdrSnapshot.loading}
                />
              </div>
            )}
            {isHerdr && herdrPane?.alive && <HerdrDrawerToggle />}
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
            />
            {!isHerdr && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setViewMode("canvas")}
                data-map-open
                className="shrink-0"
              >
                <Icon icon={Workflow} size="sm" />
                画布
              </Button>
            )}
          </div>,
          tabActionsSlot,
        )}

      {isMobile && <PendingBar mobile hiddenChrome={mobileHeaderHidden} />}
      {isHerdr && <HerdrSessionGestures scrollRef={scrollRef} contentRef={gestureContentRef} />}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        onClick={revealFromHiddenTitleArea}
        data-thread-scroll
        className="flex-1 overflow-y-auto overflow-x-hidden"
        style={
          mobileHeaderHidden
            ? {
                marginBottom:
                  "calc(var(--safe-top) - var(--trellis-header-h))",
                transform:
                  "translateY(calc(var(--safe-top) - var(--trellis-header-h)))",
              }
            : isMobile
              ? undefined
              : // 树浮窗（TreePanel 发布 --trellis-tree-safe）只在会盖住正文时才让位，
                // 宽屏下正文列左右对称居中；算法见 treeSafePadding。
                { paddingRight: treeSafePadding(threadWidth) }
        }
      >
        <main ref={gestureContentRef} className={`${widthClass} w-full max-w-full min-w-0 mx-auto px-4 md:px-8 py-4 pb-6 max-md:pb-[calc(var(--trellis-composer-h,6rem)+1rem)]`}>
        {isHerdr && session && (
          <HerdrOfflineBanner
            sessionId={session.id}
            pane={herdrPane}
            loading={herdrSnapshot.loading}
          />
        )}
        {threadData.thread.length === 0 ? (
          <EmptyState
            icon={MessageSquareDashed}
            title={
              session.origin === "external"
                ? session.externalStatus === "closed"
                  ? "外部线程已结束"
                  : "外部线程已收编"
                : "还没有对话"
            }
            description={
              session.origin === "external" && session.externalStatus !== "closed"
                ? "可以在下方直接提问，或从下面挑一句开始"
                : undefined
            }
            action={
              // 只有输入框可用（已收编、未结束的外部线程）时才给起手句：普通会话没有
              // 节点时输入框是禁用的，填进去也发不出。
              session.origin === "external" && session.externalStatus !== "closed" ? (
                <div data-empty-starters="" className="flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:justify-center">
                  {STARTER_PROMPTS.map((prompt) => (
                    <Button
                      key={prompt}
                      variant="secondary"
                      size="sm"
                      onClick={() => useComposerInsertStore.getState().queueComposerInsert(session.id, prompt)}
                    >
                      {prompt}
                    </Button>
                  ))}
                </div>
              ) : undefined
            }
          />
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
                  // Faint rule between turns so where one answer ends is
                  // visible without bringing card frames back. 手机上减线：
                  // 轮次之间只靠间距分开（用户消息自带浅灰块，足够当分隔）。
                  className={`group/turn scroll-mt-3 pb-7 max-md:pb-6 outline-none min-w-0 max-w-full ${idx > 0 && !isCompacted ? "pt-6 max-md:pt-4 md:border-t md:border-line" : "pt-1"}`}
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
                    mirrorRun={node.id === tipNode?.id ? mirrorRunLabel : null}
                  />
                  {butler && <ButlerChangeCards sessionId={session.id} nodeId={node.id} />}

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
                          className={`ui-collapse-chevron text-ink-faint ${
                            openBranches.has(node.id) ? "rotate-90" : ""
                          }`}
                        />
                      </button>
                      <Collapse open={openBranches.has(node.id)} className="ml-2">
                        <div className="mt-1.5 pl-3 border-l border-fork-line space-y-0.5">
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
                      </Collapse>
                    </div>
                  )}
              </section>
            </Fragment>
          );
        })
        )}
        {isHerdr && herdrPane && (
          // data-herdr-session-card：点「需要你」通知落地后按窗格 id 定位到这里（hooks/usePushBridge）。
          <div className="mt-4" data-herdr-session-card={herdrPane.paneId}>
            <HerdrSessionSwipeCard>
              <HerdrInteractionCard pane={herdrPane} />
            </HerdrSessionSwipeCard>
          </div>
        )}
        </main>
      </div>

      {awayFromBottom && (
        <button
          type="button"
          data-jump-to-bottom
          onClick={jumpToBottom}
          aria-label={tipStreamingId ? "回到底部，正在生成" : "回到底部"}
          className="absolute right-4 md:right-8 z-30 flex h-9 items-center gap-1.5 rounded-full bg-surface-raised/95 px-3 text-ui text-ink shadow-pop backdrop-blur transition-[bottom,background-color] duration-200 motion-reduce:transition-none hover:bg-surface-hover max-md:h-11 max-md:px-3.5"
          // 输入框随下滑收起时浮钮落到底边，不跟着消失。
          style={{
            bottom: composerIsHidden
              ? "calc(var(--safe-bottom) + 0.75rem)"
              : "calc(var(--trellis-composer-h, 6rem) + 0.75rem)",
          }}
        >
          {tipStreamingId && <StatusDot tone="live" className="animate-pulse motion-reduce:animate-none" />}
          <Icon icon={ArrowDown} size="sm" />
          <span>{tipStreamingId ? "生成中" : "回到底部"}</span>
        </button>
      )}

      <div
        ref={composerRef}
        data-safe-area="linear-composer"
        data-composer-hidden={composerIsHidden ? "true" : "false"}
        className={`shrink-0 z-20 bg-surface-canvas/95 md:bg-surface/95 transition-transform duration-200 motion-reduce:transition-none max-md:absolute max-md:inset-x-0 max-md:bottom-0 max-md:border-t max-md:border-line max-md:backdrop-blur ${
          composerIsHidden ? "max-md:translate-y-full max-md:pointer-events-none" : "translate-y-0"
        }`}
        style={{
          // 键盘弹起时底部是键盘不是 Home 条，再留安全区就是一截空白。
          paddingBottom: keyboard.open ? 0 : "var(--safe-bottom)",
          paddingRight: isMobile ? undefined : treeSafePadding(threadWidth),
        }}
      >
        <div className={`${widthClass} mx-auto px-4 md:px-8`}>
          {isHerdr ? (
            session ? (
              <HerdrComposer
                sessionId={session.id}
                pane={herdrPane}
                loading={herdrSnapshot.loading}
                mobileCompact={isMobile}
                onMobileExpandedChange={onComposerExpandedChange}
              />
            ) : null
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
