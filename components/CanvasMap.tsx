"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, ReactFlowProvider, Handle, Position, BaseEdge, useNodesInitialized, useNodesState, useReactFlow, useStore, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import { useSessionStore } from "@/stores/sessionStore";
import { layoutMap, mapCompact, mapViewport, shouldFitMap } from "@/lib/canvas-map";
import { isUnreadNode, isWaitingNode, treeLabel } from "@/lib/tree-panel";
import { buildNodeIndex } from "@/lib/node-index";
import { useScrollHideState } from "@/hooks/useScrollHide";
import type { ChatNode } from "@/lib/types";

const colors = ["#bfdbfe", "#a7f3d0", "#fde68a", "#fecdd3", "#ddd6fe", "#a5f3fc", "#fed7aa", "#d9f99d", "#f5d0fe", "#cbd5e1"];
type MapData = { node: ChatNode; index: number; active: boolean; topic: number; width: number; height: number; peek: (id: string | null) => void; select: (id: string) => void };
function MapNode({ data: d }: NodeProps<Node<MapData>>) {
  const compact = useStore(s => mapCompact(s.transform[2]));
  return <>
    <Handle type="target" position={Position.Top} className="!opacity-0" />
    <button data-map-node={d.node.id} data-map-current={d.active || undefined} data-map-compact={compact}
      aria-label={`#${d.index} ${treeLabel(d.node, 100)}${d.active ? "，当前位置" : ""}`} aria-current={d.active ? "location" : undefined}
      onFocus={() => d.peek(d.node.id)} onBlur={() => d.peek(null)} onMouseEnter={() => d.peek(d.node.id)} onMouseLeave={() => d.peek(null)}
      onClick={() => d.select(d.node.id)}
      className="nodrag nopan relative flex items-center justify-center rounded border text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
      style={{ width: d.width, height: d.height, background: colors[d.topic % colors.length], borderColor: d.active ? "#1d4ed8" : "#33415555", outline: d.active ? "3px solid #1d4ed8" : undefined, outlineOffset: 1, fontSize: compact ? 26 : 16 }}>
      <span className={compact ? "truncate px-3 font-medium" : "line-clamp-3 whitespace-normal break-words px-3 text-left leading-[22px]"}>{compact ? treeLabel(d.node, 16) : `#${d.index} ${treeLabel(d.node, 160)}`}</span>
      {(isWaitingNode(d.node) || isUnreadNode(d.node)) && <span aria-label={isWaitingNode(d.node) ? "等待处理" : "未读"} className="absolute -right-1 -top-1 h-2 w-2 rounded-full border border-white" style={{ background: isWaitingNode(d.node) ? "#d97706" : "#2563eb" }} />}
    </button>
    <Handle type="source" position={Position.Bottom} className="!opacity-0" />
  </>;
}
function TopicNode({ data }: NodeProps<Node<{ label: string; width: number; height: number; topic: number }>>) {
  return <div className="pointer-events-none rounded-lg border border-line text-ink" style={{ width: data.width, height: data.height, background: "var(--color-surface)" }}>
    <div className="truncate px-4 py-2 text-[18px] font-semibold"><span style={{ color: colors[data.topic % colors.length] }}>■ </span>{data.label}</div>
  </div>;
}
const nodeTypes = { map: MapNode, topic: TopicNode };
function MapEdge({ id, data, style }: EdgeProps) {
  const points = data?.points as { x: number; y: number }[];
  return <BaseEdge id={id} path={points.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ")} style={style} />;
}
const edgeTypes = { map: MapEdge };

export function CanvasMap(props: { mobile: boolean; close: () => void }) {
  return <ReactFlowProvider><MapInner {...props} /></ReactFlowProvider>;
}
function MapInner({ mobile, close }: { mobile: boolean; close: () => void }) {
  const nodes = useSessionStore(s => s.nodes);
  // Freeze the location on entry: background read tracking must not move the
  // marker, and a newly opened session still has a root reading position.
  const [activeId] = useState(() => {
    const s = useSessionStore.getState();
    return s.activeNodeId ?? s.readingPosition?.nodeId ?? s.session?.rootNodeId ?? Object.keys(s.nodes)[0];
  });
  const sessionId = useSessionStore(s => s.session?.id);
  const jump = useSessionStore(s => s.jumpFromMap);
  const { reveal } = useScrollHideState();
  const [peekId, setPeekId] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const select = useCallback((id: string) => { jump(id); reveal(); close(); }, [jump, reveal, close]);
  const model = useMemo(() => layoutMap(nodes, mobile, size.width ? size : undefined), [nodes, mobile, size]);
  const indices = useMemo(() => buildNodeIndex(nodes), [nodes]);
  const derivedNodes: Node[] = useMemo(() => [
    ...model.topics.map(t => ({ id: `topic:${t.id}`, type: "topic", position: { x: t.x, y: t.y }, zIndex: -1, selectable: false, focusable: false, data: { ...t, label: treeLabel(nodes[t.id], 60) } })),
    ...[...model.positions].map(([id, p]) => ({ id, type: "map", position: { x: p.x, y: p.y }, style: { pointerEvents: "all" as const }, focusable: false, data: { node: nodes[id], index: indices[id], active: id === activeId, ...p, peek: setPeekId, select } })),
  ], [model, nodes, indices, activeId, select]);
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(derivedNodes);
  useEffect(() => setFlowNodes(derivedNodes), [derivedNodes, setFlowNodes]);
  const edges = useMemo(() => model.edges.map(e => ({ ...e, type: "map", data: { points: e.points }, style: { stroke: "#64748b", strokeWidth: 2 }, zIndex: 0 })), [model]);
  const ready = useNodesInitialized();
  const { setViewport } = useReactFlow();
  const fitted = useRef<string | null>(null);
  const fitKey = `${sessionId}:${mobile}:${size.width}:${size.height}:${JSON.stringify([...model.positions])}`;
  const [fitCount, setFitCount] = useState(0);
  const fit = useCallback(() => { if (size.width && size.height) void setViewport(mapViewport(model.bounds, size), { duration: 0 }).then(() => setFitCount(n => n + 1)); }, [setViewport, model.bounds, size]);
  useEffect(() => {
    if (!shouldFitMap(ready && size.width > 0, fitKey, fitted.current)) return;
    const frame = requestAnimationFrame(() => { fitted.current = fitKey; fit(); });
    return () => cancelAnimationFrame(frame);
  }, [ready, fitKey, fit, size.width]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus(); reveal();
    // The map is modal even though it is launched inside the push panel.
    const siblings = [...document.body.children].filter(el => el instanceof HTMLElement && !el.contains(dialog.current)) as HTMLElement[];
    const old = siblings.map(el => el.inert);
    siblings.forEach(el => { el.inert = true; });
    return () => { siblings.forEach((el, i) => { el.inert = old[i]; }); if (previous?.isConnected) previous.focus(); };
  }, [reveal]);
  const peek = peekId ? nodes[peekId] : null;
  return <div ref={dialog} role="dialog" aria-modal="true" aria-label="会话地图" data-canvas-map data-map-fit-count={fitCount} data-keys-yield
    className="fixed z-[70] flex flex-col bg-surface-canvas text-ink shadow-raise md:rounded-xl md:border md:border-line"
    style={{ inset: mobile ? 0 : 24, paddingTop: mobile ? "var(--safe-top)" : undefined, paddingBottom: mobile ? "var(--safe-bottom)" : undefined }}
    onKeyDown={e => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); close(); }
      if (e.key.toLowerCase() === "f" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); fit(); }
      if (e.key === "Tab") {
        const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
        if (e.shiftKey && document.activeElement === buttons[0]) { e.preventDefault(); buttons.at(-1)?.focus(); }
        else if (!e.shiftKey && document.activeElement === buttons.at(-1)) { e.preventDefault(); buttons[0]?.focus(); }
      }
    }}>
    <div className="flex min-h-12 shrink-0 items-center gap-3 border-b border-line px-3">
      <strong>🗺 地图</strong><span className="flex-1 text-xs text-ink-muted">{model.topics.length} 话题 · {model.positions.size} 节点</span>
      <button aria-label="地图全貌" onClick={fit} className="min-h-11 px-2 text-xs">全貌</button>
      <button ref={closeButton} aria-label="关闭地图" onClick={close} className="min-h-11 min-w-11 text-xl">×</button>
    </div>
    <div ref={viewportRef} className="relative min-h-0 flex-1" data-map-viewport style={{ touchAction: "none" }}>
      <ReactFlow nodes={flowNodes} onNodesChange={onNodesChange} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} minZoom={0.01} maxZoom={2} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} proOptions={{ hideAttribution: true }} />
      {peek && <div data-map-detail className="pointer-events-none absolute bottom-3 left-3 right-3 z-10 max-w-sm rounded-lg border border-line bg-surface p-3 text-sm shadow-raise">
        <div className="mb-1 text-xs text-ink-muted">#{indices[peek.id]} · {treeLabel(peek, 80)}{peek.parentId ? ` · 接续 #${indices[peek.parentId]}` : " · 话题起点"}</div>
        <strong className="line-clamp-2">{peek.question}</strong><p className="mt-2 line-clamp-3 text-xs text-ink-muted">{peek.response || (isWaitingNode(peek) ? "等待你处理" : "尚无回复")}</p>
      </div>}
    </div>
    <p className="shrink-0 border-t border-line px-3 py-2 text-[11px] text-ink-muted">选节点回到正文 · 蓝框：当前位置 · <span className="text-blue-600">● 未读</span> · <span className="text-amber-600">● 等待处理</span></p>
  </div>;
}
