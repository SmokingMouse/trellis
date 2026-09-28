"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, ReactFlowProvider, Handle, Position, BaseEdge, useNodesInitialized, useNodesState, useReactFlow, useStore, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import { useSessionStore } from "@/stores/sessionStore";
import { layoutMap, mapCompact, mapViewport, shouldFitMap } from "@/lib/canvas-map";
import { childrenIndex, isUnreadNode, isWaitingNode, treeLabel } from "@/lib/tree-panel";
import { buildNodeIndex } from "@/lib/node-index";
import { useScrollHideState } from "@/hooks/useScrollHide";
import { useConfirmDelete } from "@/hooks/useConfirmDelete";
import {
  ContextMenu,
  useContextMenuWithTarget,
  type ContextMenuItem,
  type ContextMenuTriggerBindings,
} from "@/components/ui/ContextMenu";
import type { ChatNode } from "@/lib/types";
import { Map as MapIcon, Maximize, X } from "lucide-react";
import { Button, Icon, IconButton, StatusDot } from "@/components/ui";

// 话题色只做左侧细条 / 话题框标记（低 chroma，亮暗两套，见 globals.css 的
// --topic-N）；节点本体一律 surface + 细描边，深色模式下不再是浅色 pastel 块。
const TOPIC_COUNT = 10;
const topicColor = (topic: number) => `var(--topic-${topic % TOPIC_COUNT})`;
type MapData = {
  node: ChatNode;
  index: number;
  active: boolean;
  topic: number;
  width: number;
  height: number;
  peek: (id: string | null) => void;
  select: (id: string) => void;
  bindTrigger: (node: ChatNode) => ContextMenuTriggerBindings;
};
function MapNode({ data: d }: NodeProps<Node<MapData>>) {
  const compact = useStore(s => mapCompact(s.transform[2]));
  const trigger = d.bindTrigger(d.node);
  return <>
    <Handle type="target" position={Position.Top} className="!opacity-0" />
    <button data-map-node={d.node.id} data-map-current={d.active || undefined} data-map-compact={compact}
      aria-label={`#${d.index} ${treeLabel(d.node, 100)}${d.active ? "，当前位置" : ""}`} aria-current={d.active ? "location" : undefined}
      onFocus={() => d.peek(d.node.id)} onBlur={() => d.peek(null)} onMouseEnter={() => d.peek(d.node.id)} onMouseLeave={() => d.peek(null)}
      onClick={() => d.select(d.node.id)}
      {...trigger}
      className={`nodrag nopan relative flex items-center justify-center overflow-hidden rounded-field border bg-surface-raised text-ink transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${d.active ? "border-accent outline-3 outline-accent" : "border-line-strong"}`}
      // 宽高 / 字号是地图坐标系里的值（随缩放），不是界面尺寸，所以走 style。
      style={{ width: d.width, height: d.height, outlineOffset: 1, fontSize: compact ? 26 : 16 }}>
      <span aria-hidden className="absolute inset-y-0 left-0 w-1" style={{ background: topicColor(d.topic) }} />
      <span className={compact ? "truncate px-3 font-medium" : "line-clamp-3 whitespace-normal break-words px-3 text-left"} style={compact ? undefined : { lineHeight: "22px" }}>{compact ? treeLabel(d.node, 16) : `#${d.index} ${treeLabel(d.node, 160)}`}</span>
      {(isWaitingNode(d.node) || isUnreadNode(d.node)) && <StatusDot tone={isWaitingNode(d.node) ? "warn" : "unread"} label={isWaitingNode(d.node) ? "等待处理" : "未读"} className="absolute right-1 top-1 size-2 ring-2 ring-surface-raised" />}
    </button>
    <Handle type="source" position={Position.Bottom} className="!opacity-0" />
  </>;
}
function TopicNode({ data }: NodeProps<Node<{ label: string; width: number; height: number; topic: number }>>) {
  return <div className="pointer-events-none rounded-card border border-line bg-surface text-ink" style={{ width: data.width, height: data.height }}>
    <div className="flex items-center gap-2 truncate px-4 py-2 text-lg font-semibold">
      <span aria-hidden className="size-2.5 shrink-0 rounded-sm" style={{ background: topicColor(data.topic) }} />
      <span className="truncate">{data.label}</span>
    </div>
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
  const sessionRootId = useSessionStore(s => s.session?.rootNodeId);
  const collapsedNodeIds = useSessionStore(s => s.collapsedNodeIds);
  const toggleCollapse = useSessionStore(s => s.toggleCollapse);
  const markNodeRead = useSessionStore(s => s.markNodeRead);
  const markNodeUnread = useSessionStore(s => s.markNodeUnread);
  const toggleBookmark = useSessionStore(s => s.toggleBookmark);
  const confirmDelete = useConfirmDelete();
  const byParent = useMemo(() => childrenIndex(nodes), [nodes]);

  const {
    target: menuTarget,
    bindTrigger,
    props: menuProps,
  } = useContextMenuWithTarget<ChatNode>();

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

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menuTarget) return [];
    const isSessionRoot = sessionRootId === menuTarget.id;
    const hasChildren = (byParent.get(menuTarget.id)?.length ?? 0) > 0;
    const isCollapsed = hasChildren && collapsedNodeIds.has(menuTarget.id);
    const unread = isUnreadNode(menuTarget);
    const isBookmarked = menuTarget.bookmarkedAt !== null;

    const navItems: ContextMenuItem[] = [
      {
        label: "跳转到此节点",
        onSelect: () => select(menuTarget.id),
      },
    ];
    if (hasChildren) {
      navItems.push({
        label: isCollapsed ? "展开子树" : "折叠子树",
        onSelect: () => toggleCollapse(menuTarget.id),
      });
    }

    const editItems: ContextMenuItem[] = [];
    if (menuTarget.status === "done") {
      editItems.push({
        label: unread ? "标为已读" : "标为未读",
        onSelect: () =>
          void (unread ? markNodeRead(menuTarget.id) : markNodeUnread(menuTarget.id)),
      });
    }
    editItems.push({
      label: isBookmarked ? "移出稍后再读" : "加入稍后再读",
      onSelect: () => void toggleBookmark(menuTarget.id),
    });
    if (menuTarget.question?.trim()) {
      editItems.push({
        label: "复制问题内容",
        onSelect: () => void navigator.clipboard?.writeText(menuTarget.question),
      });
    }

    return [
      ...navItems,
      "separator",
      ...editItems,
      "separator",
      {
        label: "删除节点（含子树）",
        danger: true,
        disabled: isSessionRoot,
        hint: isSessionRoot ? "会话主根" : undefined,
        onSelect: () => confirmDelete(menuTarget.id),
      },
    ];
  }, [
    menuTarget,
    sessionRootId,
    byParent,
    collapsedNodeIds,
    select,
    toggleCollapse,
    markNodeRead,
    markNodeUnread,
    toggleBookmark,
    confirmDelete,
  ]);

  const model = useMemo(() => layoutMap(nodes, mobile, size.width ? size : undefined), [nodes, mobile, size]);
  const indices = useMemo(() => buildNodeIndex(nodes), [nodes]);
  const derivedNodes: Node[] = useMemo(() => [
    ...model.topics.map(t => ({ id: `topic:${t.id}`, type: "topic", position: { x: t.x, y: t.y }, zIndex: -1, selectable: false, focusable: false, data: { ...t, label: treeLabel(nodes[t.id], 60) } })),
    ...[...model.positions].map(([id, p]) => ({ id, type: "map", position: { x: p.x, y: p.y }, style: { pointerEvents: "all" as const }, focusable: false, data: { node: nodes[id], index: indices[id], active: id === activeId, ...p, peek: setPeekId, select, bindTrigger } })),
  ], [model, nodes, indices, activeId, select, bindTrigger]);
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(derivedNodes);
  useEffect(() => setFlowNodes(derivedNodes), [derivedNodes, setFlowNodes]);
  const edges = useMemo(() => model.edges.map(e => ({ ...e, type: "map", data: { points: e.points }, style: { stroke: "var(--edge)", strokeWidth: 2 }, zIndex: 0 })), [model]);
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
    className="fixed z-60 flex flex-col bg-surface-canvas text-ink shadow-overlay md:rounded-overlay md:border md:border-line"
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
      <strong className="inline-flex items-center gap-1.5 text-ui font-semibold"><Icon icon={MapIcon} className="text-ink-muted" />地图</strong><span className="flex-1 text-label text-ink-faint">{model.topics.length} 话题 · {model.positions.size} 节点</span>
      <Button variant="ghost" size="sm" aria-label="地图全貌" onClick={fit}><Icon icon={Maximize} size="sm" />全貌</Button>
      <IconButton ref={closeButton} label="关闭地图" shortcut="Esc" onClick={close}><Icon icon={X} /></IconButton>
    </div>
    <div ref={viewportRef} className="relative min-h-0 flex-1" data-map-viewport style={{ touchAction: "none" }}>
      <ReactFlow nodes={flowNodes} onNodesChange={onNodesChange} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} minZoom={0.01} maxZoom={2} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} proOptions={{ hideAttribution: true }} />
      {peek && <div data-map-detail className="pointer-events-none absolute bottom-3 left-3 right-3 z-10 max-w-sm rounded-card border border-line bg-surface-raised p-3 text-ui shadow-pop">
        <div className="mb-1 text-label text-ink-faint">#{indices[peek.id]} · {treeLabel(peek, 80)}{peek.parentId ? ` · 接续 #${indices[peek.parentId]}` : " · 话题起点"}</div>
        <strong className="line-clamp-2">{peek.question}</strong><p className="mt-2 line-clamp-3 text-label text-ink-muted">{peek.response || (isWaitingNode(peek) ? "等待你处理" : "尚无回复")}</p>
      </div>}
    </div>
    <p className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-line px-3 py-2 text-label text-ink-faint">
      <span>选节点回到正文</span>
      <span aria-hidden>·</span>
      <span className="inline-flex items-center gap-1"><span aria-hidden className="size-2.5 rounded-sm border-2 border-accent" />当前位置</span>
      <span className="inline-flex items-center gap-1"><StatusDot tone="unread" />未读</span>
      <span className="inline-flex items-center gap-1"><StatusDot tone="warn" />等待处理</span>
    </p>
    <ContextMenu
      {...menuProps}
      label="地图节点菜单"
      items={menuItems}
    />
  </div>;
}
