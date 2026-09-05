"use client";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  useReactFlow,
  useStore as useFlowStore,
  type Node,
  type Edge,
} from "@xyflow/react";
import { useMemo, useEffect, useState, useCallback, useRef } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { useIsMobile } from "@/hooks/useIsMobile";
import { isEditableTarget } from "@/lib/shortcuts";
import { ChatNode, type ChildAnchor } from "./ChatNode";
import { ReferenceCard } from "./ReferenceCard";
import { AddNodeFAB } from "./AddNodeFAB";
import { BranchPopover } from "./BranchPopover";
import { Composer } from "./Composer";
import { Outline } from "./Outline";
import { TargetChip } from "./TargetChip";
import {
  useSelectionWithin,
  type SelectionInfo,
} from "@/hooks/useSelectionWithin";
import { layoutNodes, COMPACT_ZOOM_THRESHOLD } from "@/lib/layout";
import { buildNodeIndex } from "@/lib/node-index";
import { hiddenCanvasNodeIds } from "@/lib/collapsed";

const nodeTypes = { chat: ChatNode, reference: ReferenceCard };
const NODE_WIDTH = 600;
const NODE_HEIGHT_ESTIMATE = 480;
const EMPTY_ANCHORS: ChildAnchor[] = [];

export function Canvas({ onNodeFocus }: { onNodeFocus?: () => void } = {}) {
  return (
    <ReactFlowProvider>
      <CanvasInner onNodeFocus={onNodeFocus} />
    </ReactFlowProvider>
  );
}

// (Previous READ_ZOOM / OVERVIEW_THRESHOLD constants removed: the
// auto-zoom-on-focus behavior was contributing to a feedback loop with the
// LoD threshold. Active-node focus now preserves the user's current zoom.)

function CanvasInner({ onNodeFocus }: { onNodeFocus?: () => void }) {
  const isMobile = useIsMobile();
  const nodeMap = useSessionStore((s) => s.nodes);
  const setNodePosition = useSessionStore((s) => s.setNodePosition);
  const activeNodeId = useSessionStore((s) => s.activeNodeId);
  const setActiveNode = useSessionStore((s) => s.setActiveNode);
  const collapsedNodeIds = useSessionStore((s) => s.collapsedNodeIds);
  const sessionId = useSessionStore((s) => s.session?.id);
  const { setCenter, getViewport, fitView } = useReactFlow();
  const mobileFitScheduled = useRef(false);

  // Folded subtrees and hidden trees disappear from the canvas:
  // - Collapsed roots stay visible (their "+N" badge invites re-expansion),
  //   while their descendants are excluded from layout, flowNodes, and flowEdges.
  // - Hidden trees (root.hiddenAt !== null) are completely excluded.
  const hiddenIds = useMemo(
    () => hiddenCanvasNodeIds(collapsedNodeIds, nodeMap),
    [collapsedNodeIds, nodeMap],
  );

  // First-mount nodes start at (0,0) and snap to dagre output on the
  // first layout pass — animating that flight from origin looks worse
  // than just popping into place. Gate the transform transition behind
  // this flag so subsequent re-layouts (collapse / streaming finish /
  // LoD threshold) slide smoothly without that initial fly-in.
  const [layoutReady, setLayoutReady] = useState(false);

  // Per-node "peek": expand a compact card into its full form in place, on
  // the canvas, without jumping to the linear reader. Multiple can be open at
  // once. Folded into layoutKey so dagre reflows neighbors (the expanded card
  // is taller AND wider than a compact one — see layoutNodes' measured
  // width/height handling). Ids are per-session-unique (UUIDs), so a peeked id
  // from another session simply never matches the current node map — no reset
  // needed, and switching back to a session restores its peeked cards.
  const [peekedIds, setPeekedIds] = useState<Set<string>>(new Set());
  const togglePeek = useCallback((id: string) => {
    setPeekedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // LoD-aware: layout shrinks when zoom drops below the threshold so
  // overview cards (compact form) sit close together — selector returns a
  // boolean so we only re-layout on threshold crossings, not every wheel.
  const isCompact = useFlowStore(
    (s) => s.transform[2] < COMPACT_ZOOM_THRESHOLD,
  );

  // Re-layout when topology changes, when a node's status flips
  // (streaming → done → height stabilizes), or when LoD threshold crosses.
  // Streaming text deltas don't change this key, so layout doesn't thrash
  // on every chunk.
  const layoutKey = useMemo(
    () =>
      Object.values(nodeMap)
        .map((n) => `${n.id}:${n.parentId ?? "_"}:${n.status}`)
        .sort()
        .join("|") +
      (isCompact ? ":c" : ":f") +
      "|h=" +
      [...hiddenIds].sort().join(",") +
      "|p=" +
      [...peekedIds].sort().join(","),
    [nodeMap, isCompact, hiddenIds, peekedIds],
  );

  const { getNodes } = useReactFlow();

  useEffect(() => {
    const visibleNodes = Object.values(nodeMap).filter(
      (n) => !hiddenIds.has(n.id),
    );
    if (visibleNodes.length === 0) return;
    // Wait one tick so React Flow has rendered + measured heights of any
    // newly-added/changed nodes before we re-run Dagre. Peeked cards use a
    // fixed reserved footprint (see layoutNodes' forceFullIds), so a single
    // pass already reflows descendants correctly — no measurement retry needed.
    const t = window.setTimeout(() => {
      const heights = new Map<string, number>();
      for (const fn of getNodes()) {
        const h = fn.measured?.height;
        if (typeof h === "number" && h > 0) heights.set(fn.id, h);
      }
      const positions = layoutNodes(visibleNodes, heights, {
        compact: isCompact,
        forceFullIds: peekedIds,
      });
      for (const [id, pos] of positions) {
        const cur = nodeMap[id];
        if (!cur) continue;
        if (
          Math.abs(cur.position.x - pos.x) > 0.5 ||
          Math.abs(cur.position.y - pos.y) > 0.5
        ) {
          setNodePosition(id, pos);
        }
      }
      // After the first real dagre pass with measured heights, allow
      // subsequent transform changes to animate. Wait until the next
      // frame so the new positions paint before transitions arm.
      requestAnimationFrame(() => setLayoutReady(true));
    }, 60);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  // Pan smoothly to the active node whenever the user explicitly changes it.
  // Intentionally NOT depending on activeX/activeY: dagre re-layouts (e.g.
  // LoD threshold crossings) would otherwise re-fire setCenter every time
  // positions shift, and the resulting zoom changes can cascade back into
  // LoD toggles. Pan only when activeNodeId actually changes; preserve the
  // user's current zoom rather than auto-bumping to READ_ZOOM, which used to
  // form the other half of the LoD oscillation loop.
  const activeNode = activeNodeId ? nodeMap[activeNodeId] : null;
  useEffect(() => {
    if (!activeNode || hiddenIds.has(activeNode.id)) return;
    const id = requestAnimationFrame(() => {
      const { zoom: cur } = getViewport();
      setCenter(
        activeNode.position.x + NODE_WIDTH / 2,
        activeNode.position.y + NODE_HEIGHT_ESTIMATE / 2,
        { zoom: cur, duration: 500 },
      );
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNodeId, hiddenIds]);

  // Re-fit view when switching sessions — fitView prop only fires on mount.
  // Also drop the layout-ready flag so the new session's first dagre
  // pass doesn't animate cards flying in from origin.
  //
  // When Canvas is remounting because the user just left the linear thread
  // (viewMode → "canvas"), activeNodeId is already pointing at the node
  // we want to land on (set by setViewMode). Skip the auto-land in that
  // case so the activeNodeId effect can pan/zoom to that node without
  // being overwritten by a global fit a few frames later.
  //
  // 80/20 landing: when activeNodeId is null at session load (fresh
  // hydrate / page refresh / picker switch), pan to the freshest piece
  // of work — store's lastEditedNodeId — instead of fitView'ing the
  // whole tree. fitView with a deep tree drops the user at the root or
  // a wide overview that's almost never what they came back for. We read
  // store state inside the timeout (after dagre has laid out positions
  // ~60ms in) and fall back to fitView only when there's no candidate.
  useEffect(() => {
    if (!sessionId) return;
    setLayoutReady(false);
    if (activeNodeId) return;
    const t = window.setTimeout(() => {
      const state = useSessionStore.getState();
      const fresh =
        state.lastEditedNodeId && state.nodes[state.lastEditedNodeId];
      if (fresh && fresh.position && !hiddenIds.has(fresh.id)) {
        const { zoom: cur } = getViewport();
        setCenter(
          fresh.position.x + NODE_WIDTH / 2,
          fresh.position.y + NODE_HEIGHT_ESTIMATE / 2,
          { zoom: cur, duration: 400 },
        );
      } else {
        fitView({ padding: 0.15, duration: 400 });
      }
    }, 120);
    return () => window.clearTimeout(t);
    // activeNodeId is intentionally a snapshot read at session-change /
    // mount time — we don't want every later setActiveNode to re-fire
    // this layout reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, fitView, setCenter, getViewport]);

  // M11: entering the canvas on a phone starts from a readable overview.
  // Wait until the first measured Dagre pass (60ms above) has painted, then
  // fit exactly once for this Canvas mount. Returning from linear remounts
  // Canvas and schedules a fresh fit; desktop keeps its existing landing.
  useEffect(() => {
    if (!isMobile || mobileFitScheduled.current) return;
    const timer = window.setTimeout(() => {
      if (mobileFitScheduled.current) return;
      mobileFitScheduled.current = true;
      fitView({ padding: 0.15, duration: 400 });
    }, 240);
    return () => window.clearTimeout(timer);
  }, [isMobile, fitView]);

  // F key → fit to overview. Skip when typing in inputs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if ((e.key === "f" || e.key === "F") && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        fitView({ padding: 0.15, duration: 400 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fitView]);

  // Derive childAnchors per parent once at the canvas level, so each ChatNode
  // doesn't have to subscribe to the entire nodes map and re-filter on every
  // streaming delta. Using an empty-array constant for parents with no
  // anchored children keeps the prop reference stable across renders.
  const childAnchorsByParent = useMemo(() => {
    const map = new Map<string, ChildAnchor[]>();
    for (const n of Object.values(nodeMap)) {
      if (!n.parentId || !n.parentAnchor?.selectedText) continue;
      const arr = map.get(n.parentId) ?? [];
      arr.push({ text: n.parentAnchor.selectedText, childId: n.id });
      map.set(n.parentId, arr);
    }
    return map;
  }, [nodeMap]);

  const nodeIndices = useMemo(() => buildNodeIndex(nodeMap), [nodeMap]);

  // Per-node descendant counts in one pass — drives the "▶ N" / "▼ N"
  // chip on cards. Build a children map then DFS post-order so each id
  // accumulates its subtree size in linear time.
  const descendantCounts = useMemo(() => {
    const childrenByParent = new Map<string, string[]>();
    for (const n of Object.values(nodeMap)) {
      if (!n.parentId) continue;
      const arr = childrenByParent.get(n.parentId) ?? [];
      arr.push(n.id);
      childrenByParent.set(n.parentId, arr);
    }
    const counts: Record<string, number> = {};
    const visit = (id: string): number => {
      if (counts[id] !== undefined) return counts[id];
      const kids = childrenByParent.get(id) ?? [];
      let sum = 0;
      for (const k of kids) sum += 1 + visit(k);
      counts[id] = sum;
      return sum;
    };
    for (const id of Object.keys(nodeMap)) visit(id);
    return counts;
  }, [nodeMap]);

  const flowNodes: Node[] = useMemo(
    () =>
      Object.values(nodeMap)
        .filter((n) => !hiddenIds.has(n.id))
        .map((n) => {
          const isReference = n.kind === "reference";
          const index = nodeIndices[n.id] ?? 0;
          const descendantCount = descendantCounts[n.id] ?? 0;
          const collapsed = collapsedNodeIds.has(n.id);
          return {
            id: n.id,
            type: isReference ? "reference" : "chat",
            position: n.position,
            // Peeked cards float above neighbors — a wide expanded card can
            // briefly overlap during reflow, and it should never sit under the
            // small cards around it.
            zIndex: peekedIds.has(n.id) ? 1000 : undefined,
            data: isReference
              ? {
                  node: n,
                  isActive: n.id === activeNodeId,
                  index,
                  descendantCount,
                  collapsed,
                }
              : {
                  node: n,
                  isActive: n.id === activeNodeId,
                  childAnchors:
                    childAnchorsByParent.get(n.id) ?? EMPTY_ANCHORS,
                  index,
                  descendantCount,
                  collapsed,
                  isPeeked: peekedIds.has(n.id),
                  onTogglePeek: togglePeek,
                },
            draggable: false,
          };
        }),
    [
      nodeMap,
      activeNodeId,
      childAnchorsByParent,
      nodeIndices,
      hiddenIds,
      descendantCounts,
      collapsedNodeIds,
      peekedIds,
      togglePeek,
    ],
  );

  const flowEdges: Edge[] = useMemo(
    () =>
      Object.values(nodeMap)
        .filter(
          (n) => n.parentId && !hiddenIds.has(n.id) && !hiddenIds.has(n.parentId),
        )
        .map((n) => ({
          id: `e-${n.id}`,
          source: n.parentId!,
          target: n.id,
          type: "default",
        })),
    [nodeMap, hiddenIds],
  );

  const liveSelection = useSelectionWithin();
  const [popover, setPopover] = useState<{
    selection: SelectionInfo;
    expanded: boolean;
  } | null>(null);

  useEffect(() => {
    setPopover((prev) => {
      // A canvas card only exposes a selectable body when it renders full —
      // peeked, streaming, or an unsuperseded error (mirrors ChatNode's
      // showCompact).
      const rendersFull = (id: string) => {
        const n = nodeMap[id];
        return (
          !!n &&
          (peekedIds.has(id) ||
            n.status === "streaming" ||
            (n.status === "error" && (descendantCounts[id] ?? 0) === 0))
        );
      };
      // Expanded popover stays sticky — it composes off snapshots
      // (selection.text/rect), so a collapsing card mustn't discard in-progress
      // typing. Checked FIRST so the close-gate below only touches the
      // collapsed (two-button) popover.
      if (prev?.expanded) return prev;
      // Collapsed popover whose card stopped rendering full (e.g. the user hit
      // 收起 without dismissing first): its selectable body is gone, so close
      // it — otherwise the buttons hang on the canvas.
      if (prev && !rendersFull(prev.selection.nodeId)) return null;
      if (liveSelection && rendersFull(liveSelection.nodeId)) {
        // Keep the same object when the selection is unchanged, so nodeMap
        // ticks (e.g. another node streaming) don't churn a re-render while a
        // popover is open. (prev is non-expanded here — expanded returned above.)
        if (prev && prev.selection === liveSelection) return prev;
        return { selection: liveSelection, expanded: false };
      }
      return null;
    });
  }, [liveSelection, peekedIds, nodeMap, descendantCounts]);

  const closePopover = () => {
    setPopover(null);
    window.getSelection()?.removeAllRanges();
  };
  const expandPopover = () => {
    setPopover((prev) => (prev ? { ...prev, expanded: true } : prev));
  };

  return (
    <>
      <div
        data-canvas-surface
        className={`w-screen h-screen pt-12 md:pt-[5.25rem] bg-gradient-to-b from-surface-canvas via-surface to-surface-muted${
          layoutReady ? " canvas-layout-ready" : ""
        }`}
        // Wave 4: shift the canvas right of the explorer sidebar (var set in
        // page.tsx; 0 on mobile / when collapsed). box-border keeps the
        // element 100vw while the inner ReactFlow area shrinks by the pad.
        // paddingBottom 同理让出终端面板高度，否则画布下缘被面板盖住。
        style={{
          paddingLeft: "var(--trellis-sb, 0px)",
          paddingBottom: "var(--trellis-term-h, 0px)",
          boxSizing: "border-box",
        }}
      >
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          minZoom={0.2}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{ type: "smoothstep", style: { strokeWidth: 1.5 } }}
          onNodeClick={(_, node) => {
            setActiveNode(node.id);
            onNodeFocus?.();
          }}
          onPaneClick={() => fitView({ padding: 0.15, duration: 400 })}
        >
          <Background gap={22} size={1} color="#d6d3d1" className="opacity-60 dark:opacity-[0.18]" />
        </ReactFlow>
      </div>
      {/* Always-visible "fit view" floating button — replaces F key on mobile */}
      <button
        onClick={() => fitView({ padding: 0.15, duration: 400 })}
        className="fixed top-[60px] right-3 z-30 w-10 h-10 rounded-full bg-surface border border-line shadow-raise flex items-center justify-center text-ink-muted hover:bg-surface-muted active:scale-95 transition-transform"
        title="回到全局视图 (F / 点击空白)"
        aria-label="回到全局视图"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" />
        </svg>
      </button>
      {popover?.selection && (
        <BranchPopover
          selection={popover.selection}
          expanded={popover.expanded}
          onExpand={expandPopover}
          onClose={closePopover}
        />
      )}
      <AddNodeFAB />
      <DockedComposer />
      <Outline />
    </>
  );
}

// #3: the tree view's FIXED bottom input region. Follow-ups used to live
// inside each card's footer, which jumps around as dagre re-layouts during
// streaming — this bar is docked to the viewport so the input never moves.
// It continues from the active node (falling back to the freshest work /
// root); the target chip makes the branch point explicit.
function DockedComposer() {
  const nodeMap = useSessionStore((s) => s.nodes);
  const activeNodeId = useSessionStore((s) => s.activeNodeId);
  const lastEditedNodeId = useSessionStore((s) => s.lastEditedNodeId);
  const rootNodeId = useSessionStore((s) => s.session?.rootNodeId);
  const nodeIndices = useMemo(() => buildNodeIndex(nodeMap), [nodeMap]);

  const target =
    (activeNodeId ? nodeMap[activeNodeId] : undefined) ??
    (lastEditedNodeId ? nodeMap[lastEditedNodeId] : undefined) ??
    (rootNodeId ? nodeMap[rootNodeId] : undefined) ??
    null;

  const targetLabel = target
    ? target.topicLabel ??
      (target.kind === "reference"
        ? "参考材料"
        : target.question.length > 24
          ? `${target.question.slice(0, 24)}…`
          : target.question)
    : null;

  return (
    <div
      className="fixed right-0 z-20"
      // S1 P1: docked composer 坐在终端面板之上（--trellis-term-h 由
      // TerminalPanel 发布；关闭时 0px = 贴底，与原来一致）。
      style={{
        left: "var(--trellis-sb, 0px)",
        bottom: "var(--trellis-term-h, 0px)",
      }}
    >
      <div className="border-t border-line/80 bg-surface-canvas/95 backdrop-blur">
        <div className="max-w-2xl mx-auto px-4">
          {target && (
            <TargetChip
              icon="⑂"
              verb="回复"
              index={nodeIndices[target.id] ?? "?"}
              label={targetLabel ?? ""}
              hint="点卡片可切换目标"
            />
          )}
          <Composer targetNode={target} placeholder="对选中节点继续追问…" />
        </div>
      </div>
    </div>
  );
}
