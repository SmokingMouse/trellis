import dagre from "@dagrejs/dagre";
import type { ChatNode } from "./types";

// LoD threshold shared with ChatNode + Canvas. Below this zoom, cards
// collapse to the compact "topic card" form and dagre re-runs with
// tighter node dimensions, so fit-view yields a higher zoom and the
// labels actually look big in overview.
// Set above Canvas's maxZoom (1.5) to effectively skip the inline
// full-card preview tier — the canvas always shows compact topic
// cards, and reading happens in NodeFullView instead. Lower it (e.g.
// back to 0.9) to bring the on-canvas full-card tier back without
// touching ChatNode / Canvas code.
export const COMPACT_ZOOM_THRESHOLD = 999;

// Full-mode dimensions (current behavior).
const NODE_WIDTH_FULL = 600;
export const NODE_HEIGHT_ESTIMATE = 480;

// A peeked card is rendered at this FIXED height (content scrolls inside it),
// so the layout can reserve an exact footprint — no measurement round-trip,
// so descendants get pushed clear of it in a single pass. ChatNode pins the
// card to the same height; keep the two in sync.
export const PEEK_CARD_HEIGHT = 480;
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
  opts: { compact?: boolean; forceFullIds?: Set<string> } = {},
): Map<string, { x: number; y: number }> {
  const compact = opts.compact ?? false;
  const forceFull = opts.forceFullIds;
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

  // Full mode honors measurements so long answers don't overlap shorter
  // siblings. Compact mode normally packs uniformly at NH_DEFAULT — BUT a
  // streaming/error node still renders as the full 600px card even on a
  // compact canvas (ChatNode: showCompact = isCompact && !isStreaming &&
  // !isError). If we reserved only the compact 90px for it, the node below
  // overlaps it. So in compact mode honor the measured height when it's
  // TALLER than the compact default (= a not-actually-compact card), while
  // keeping uniform packing for genuinely compact cards.
  const heightFor = (id: string) => {
    // Peeked cards render at a fixed height (content scrolls inside), so
    // reserve exactly that — deterministic, no dependence on the lagging
    // measurement, so descendants reflow correctly on the first pass.
    if (forceFull?.has(id)) return PEEK_CARD_HEIGHT;
    if (!compact) return measuredHeights?.get(id) ?? NH_DEFAULT;
    const m = measuredHeights?.get(id);
    return m && m > NH_DEFAULT ? m : NH_DEFAULT;
  };

  // A peeked card renders as the fixed 600px full card even on a compact
  // canvas, where everyone else packs at the uniform 280px slot — reserve its
  // real width so it doesn't overlap its horizontal siblings.
  const widthFor = (id: string) =>
    forceFull?.has(id) ? NODE_WIDTH_FULL : NW;

  for (const n of nodes) {
    g.setNode(n.id, { width: widthFor(n.id), height: heightFor(n.id) });
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
      x: dn.x - widthFor(n.id) / 2,
      y: dn.y - heightFor(n.id) / 2,
    });
  }
  return positions;
}
