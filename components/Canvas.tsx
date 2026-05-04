"use client";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  useReactFlow,
  useStore as useFlowStore,
  type Node,
  type Edge,
} from "@xyflow/react";
import { useMemo, useEffect, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { ChatNode, type ChildAnchor } from "./ChatNode";
import { ReferenceCard } from "./ReferenceCard";
import { AddNodeFAB } from "./AddNodeFAB";
import { BranchPopover } from "./BranchPopover";
import { Outline } from "./Outline";
import {
  useSelectionWithin,
  type SelectionInfo,
} from "@/hooks/useSelectionWithin";
import { layoutNodes, COMPACT_ZOOM_THRESHOLD } from "@/lib/layout";

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
  const nodeMap = useSessionStore((s) => s.nodes);
  const setNodePosition = useSessionStore((s) => s.setNodePosition);
  const activeNodeId = useSessionStore((s) => s.activeNodeId);
  const setActiveNode = useSessionStore((s) => s.setActiveNode);
  const sessionId = useSessionStore((s) => s.session?.id);
  const { setCenter, getViewport, fitView } = useReactFlow();

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
        .join("|") + (isCompact ? ":c" : ":f"),
    [nodeMap, isCompact],
  );

  const { getNodes } = useReactFlow();

  useEffect(() => {
    const nodes = Object.values(nodeMap);
    if (nodes.length === 0) return;
    // Wait one tick so React Flow has rendered + measured heights of any
    // newly-added/changed nodes before we re-run Dagre.
    const t = window.setTimeout(() => {
      const heights = new Map<string, number>();
      for (const fn of getNodes()) {
        const h = fn.measured?.height;
        if (typeof h === "number" && h > 0) heights.set(fn.id, h);
      }
      const positions = layoutNodes(nodes, heights, { compact: isCompact });
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
    if (!activeNode) return;
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
  }, [activeNodeId]);

  // Re-fit view when switching sessions — fitView prop only fires on mount.
  useEffect(() => {
    if (!sessionId) return;
    const t = window.setTimeout(
      () => fitView({ padding: 0.15, duration: 400 }),
      120,
    );
    return () => window.clearTimeout(t);
  }, [sessionId, fitView]);

  // F key → fit to overview. Skip when typing in inputs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
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

  const flowNodes: Node[] = useMemo(
    () =>
      Object.values(nodeMap).map((n) => {
        const isReference = n.kind === "reference";
        return {
          id: n.id,
          type: isReference ? "reference" : "chat",
          position: n.position,
          data: isReference
            ? {
                node: n,
                isActive: n.id === activeNodeId,
              }
            : {
                node: n,
                isActive: n.id === activeNodeId,
                childAnchors:
                  childAnchorsByParent.get(n.id) ?? EMPTY_ANCHORS,
              },
          draggable: false,
        };
      }),
    [nodeMap, activeNodeId, childAnchorsByParent],
  );

  const flowEdges: Edge[] = useMemo(
    () =>
      Object.values(nodeMap)
        .filter((n) => n.parentId)
        .map((n) => ({
          id: `e-${n.id}`,
          source: n.parentId!,
          target: n.id,
          type: "default",
        })),
    [nodeMap],
  );

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

  const closePopover = () => {
    setPopover(null);
    window.getSelection()?.removeAllRanges();
  };
  const expandPopover = () => {
    setPopover((prev) => (prev ? { ...prev, expanded: true } : prev));
  };

  return (
    <>
      <div className="w-screen h-screen pt-12">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          minZoom={0.2}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, node) => {
            setActiveNode(node.id);
            onNodeFocus?.();
          }}
          onPaneClick={() => fitView({ padding: 0.15, duration: 400 })}
        >
          <Background gap={24} size={1} color="#e7e5e4" />
          <Controls position="bottom-right" showInteractive={false} />
        </ReactFlow>
      </div>
      {/* Always-visible "fit view" floating button — replaces F key on mobile */}
      <button
        onClick={() => fitView({ padding: 0.15, duration: 400 })}
        className="fixed top-[60px] right-3 z-30 w-10 h-10 rounded-full bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 shadow-md flex items-center justify-center text-stone-700 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800 active:scale-95 transition-transform"
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
      <Outline />
    </>
  );
}
