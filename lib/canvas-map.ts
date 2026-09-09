import type { ChatNode } from "./types";
import { childrenIndex, nodeSort } from "./tree-panel";
import dagre from "@dagrejs/dagre";

// The canvas is a map overlay; persisted reading always stays linear.
export const CANVAS_MAP = true;
export function normalizeViewMode(value: unknown, enabled = CANVAS_MAP): "linear" | "canvas" | undefined {
  if (enabled) return "linear";
  return value === "linear" || value === "canvas" ? value : undefined;
}
export function migrateMapUrl(url: URL, enabled = CANVAS_MAP) {
  if (enabled) for (const key of ["view", "viewMode", "mode"]) {
    if (["canvas", "linear"].includes(url.searchParams.get(key) ?? "")) url.searchParams.delete(key);
  }
  return url;
}
// Below 0.9 show a colour block + short label; at/above it show a readable title.
export const MAP_COMPACT_ZOOM = 0.9;
export const mapCompact = (zoom: number) => zoom < MAP_COMPACT_ZOOM;
export const MAP_FIT_OPTIONS = { padding: 16, minZoom: 0.01, maxZoom: 1.4, duration: 0 };
export const shouldFitMap = (ready: boolean, key: string, fitted: string | null) => ready && key !== fitted;

export type MapSize = { width: number; height: number };
export type MapRect = MapSize & { x: number; y: number };
export const MAP_RANK_GAP = 32;
export const MAP_SIBLING_GAP = 28;
export const MAP_TOPIC_HEADER = 44;
export function mapViewport(bounds: MapRect, viewport: MapSize) {
  const zoom = Math.max(MAP_FIT_OPTIONS.minZoom, Math.min(MAP_FIT_OPTIONS.maxZoom,
    Math.max(1, viewport.width - 32) / Math.max(1, bounds.width),
    Math.max(1, viewport.height - 32) / Math.max(1, bounds.height)));
  return { x: (viewport.width - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: (viewport.height - bounds.height * zoom) / 2 - bounds.y * zoom, zoom };
}

/** Each topic is an independent top-down dagre tree. Shelf packing wraps whole
 * topics, never nodes. Edges stay in the empty rank corridor below the parent.
 */
export function layoutMap(nodes: Record<string, ChatNode>, mobile: boolean, viewport: MapSize = { width: mobile ? 390 : 1390, height: mobile ? 720 : 770 }) {
  const children = childrenIndex(nodes);
  type MapTree = { node: ChatNode; children: MapTree[] };
  const attach = (node: ChatNode, seen = new Set<string>()): MapTree => {
    const path = new Set(seen).add(node.id);
    return { node, children: (children.get(node.id) ?? []).filter(n => !path.has(n.id)).map(n => attach(n, path)) };
  };
  const forest = Object.values(nodes).filter(n => !n.parentId || !nodes[n.parentId])
    .sort((a, b) => a.createdAt - b.createdAt || nodeSort(a, b)).map(n => attach(n));
  // On phones, a large forest uses narrow overview cards so wide branching
  // topics do not consume the entire width while leaving the height unused.
  const width = mobile ? (Object.keys(nodes).length > 20 ? 160 : 320) : 420;
  const height = 80, padding = 16, topicGap = 32;
  const positions = new Map<string, { x: number; y: number; width: number; height: number; topic: number; parentId: string | null }>();
  const topics: { id: string; x: number; y: number; width: number; height: number; topic: number }[] = [];
  const trees = forest.map(tree => {
    const flat: typeof tree[] = [];
    const visit = (t: typeof tree) => { flat.push(t); t.children.forEach(visit); };
    visit(tree);
    const graph = new dagre.graphlib.Graph().setGraph({ rankdir: "TB", nodesep: MAP_SIBLING_GAP, ranksep: MAP_RANK_GAP });
    graph.setDefaultEdgeLabel(() => ({}));
    flat.forEach(t => graph.setNode(t.node.id, { width, height }));
    flat.forEach(t => t.children.forEach(child => graph.setEdge(t.node.id, child.node.id)));
    dagre.layout(graph);
    return { tree, flat, graph, width: graph.graph().width! + 2 * padding, height: graph.graph().height! + MAP_TOPIC_HEADER + padding };
  });
  const area = trees.reduce((sum, t) => sum + (t.width + topicGap) * (t.height + topicGap), 0);
  const wrapWidth = Math.max(viewport.width, ...trees.map(t => t.width), Math.sqrt(area * viewport.width / Math.max(1, viewport.height)));
  let x = 0, y = 0, rowHeight = 0;
  trees.forEach((t, topic) => {
    if (x && x + t.width > wrapWidth) { x = 0; y += rowHeight + topicGap; rowHeight = 0; }
    t.flat.forEach(({ node }) => positions.set(node.id, {
      x: x + padding + t.graph.node(node.id).x - width / 2,
      y: y + MAP_TOPIC_HEADER + t.graph.node(node.id).y - height / 2,
      width, height, topic, parentId: node.id === t.tree.node.id ? null : node.parentId,
    }));
    topics.push({ id: t.tree.node.id, x, y, width: t.width, height: t.height, topic });
    x += t.width + topicGap;
    rowHeight = Math.max(rowHeight, t.height);
  });
  const bounds = { x: 0, y: 0, width: Math.max(0, ...topics.map(t => t.x + t.width)), height: Math.max(0, ...topics.map(t => t.y + t.height)) };
  if (topics.length === 1) {
    const zoom = mapViewport(bounds, viewport).zoom;
    const extraX = Math.max(0, (viewport.width - 32) / zoom - bounds.width);
    const extraY = Math.max(0, (viewport.height - 32) / zoom - bounds.height);
    positions.forEach(p => { p.x += extraX / 2; p.y += extraY / 2; });
    topics[0].width = bounds.width += extraX;
    topics[0].height = bounds.height += extraY;
  }
  const edges = [...positions].flatMap(([id, p]) => {
    const parent = p.parentId ? positions.get(p.parentId) : null;
    if (!parent || parent.topic !== p.topic) return [];
    const source = { x: parent.x + parent.width / 2, y: parent.y + parent.height };
    const target = { x: p.x + p.width / 2, y: p.y };
    return [{ id: `e:${id}`, source: p.parentId!, target: id, points: [source,
      { x: source.x, y: (source.y + target.y) / 2 },
      { x: target.x, y: (source.y + target.y) / 2 }, target] }];
  });
  return { positions, topics, bounds, edges };
}
