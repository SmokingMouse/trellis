import dagre from "@dagrejs/dagre";
import type { ChatNode } from "./types";

// LoD threshold shared with ChatNode + Canvas. Below this zoom, cards
// collapse to the compact "topic card" form and dagre re-runs with
// tighter node dimensions, so fit-view yields a higher zoom and the
// labels actually look big in overview.
export const COMPACT_ZOOM_THRESHOLD = 0.9;

// Full-mode dimensions (current behavior).
const NODE_WIDTH_FULL = 600;
export const NODE_HEIGHT_ESTIMATE = 480;
const RANK_SEP_FULL = 100;
const NODE_SEP_FULL = 80;

// Compact-mode dimensions — picked so fit-view of a typical tree settles
// around zoom ~0.5, where the 26px label still shows as ~13px on screen.
const NODE_WIDTH_COMPACT = 280;
const NODE_HEIGHT_COMPACT = 90;
const RANK_SEP_COMPACT = 36;
const NODE_SEP_COMPACT = 24;

export function layoutNodes(
  nodes: ChatNode[],
  measuredHeights?: Map<string, number>,
  opts: { compact?: boolean } = {},
): Map<string, { x: number; y: number }> {
  const compact = opts.compact ?? false;
  const NW = compact ? NODE_WIDTH_COMPACT : NODE_WIDTH_FULL;
  const NH_DEFAULT = compact ? NODE_HEIGHT_COMPACT : NODE_HEIGHT_ESTIMATE;
  const rankSep = compact ? RANK_SEP_COMPACT : RANK_SEP_FULL;
  const nodeSep = compact ? NODE_SEP_COMPACT : NODE_SEP_FULL;

  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "TB",
    nodesep: nodeSep,
    ranksep: rankSep,
    marginx: 40,
    marginy: 40,
  });
  g.setDefaultEdgeLabel(() => ({}));

  // Compact mode ignores measured heights — every card is the same compact
  // size, so dagre packs them uniformly. Full mode honors measurements so
  // long answers don't overlap shorter siblings.
  const heightFor = (id: string) =>
    compact ? NH_DEFAULT : (measuredHeights?.get(id) ?? NH_DEFAULT);

  for (const n of nodes) {
    g.setNode(n.id, { width: NW, height: heightFor(n.id) });
  }
  for (const n of nodes) {
    if (n.parentId) g.setEdge(n.parentId, n.id);
  }

  dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const dn = g.node(n.id);
    if (!dn) continue;
    positions.set(n.id, {
      x: dn.x - NW / 2,
      y: dn.y - heightFor(n.id) / 2,
    });
  }
  return positions;
}
