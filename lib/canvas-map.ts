import type { ChatNode } from "./types";
import { buildStructure } from "./structure-panel";

// Build-time rollback: keep the old reader for one release.
export const CANVAS_MAP = process.env.NEXT_PUBLIC_TRELLIS_CANVAS_MAP !== "off" && process.env.NEXT_PUBLIC_TRELLIS_CANVAS_MAP !== "0";
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
export const MAP_COMPACT_ZOOM = 1.15;
export const mapCompact = (zoom: number) => zoom < MAP_COMPACT_ZOOM;
export const MAP_FIT_OPTIONS = { padding: 0.035, minZoom: 0.01, maxZoom: 1, duration: 0 };
export const shouldFitMap = (ready: boolean, key: string, fitted: string | null) => ready && key !== fitted;

/** Pack complete topics into balanced lanes. Wrap each depth-first sequence;
 * edges retain parentage, numbering retains reading order. Never omit nodes,
 * aggregate them, or use the reader's collapsed state to hide branches.
 */
export function layoutMap(nodes: Record<string, ChatNode>, mobile: boolean) {
  const forest = buildStructure(nodes, null).forest;
  const lanes = mobile ? 2 : 3, columns = mobile ? 3 : 4;
  const width = mobile ? 49 : 80, height = mobile ? 22 : 32;
  const gap = mobile ? 5 : 12, rowGap = mobile ? 5 : 18;
  const laneWidth = columns * (width + gap) + 12;
  const bottoms = Array(lanes).fill(0) as number[];
  const positions = new Map<string, { x: number; y: number; width: number; height: number; topic: number; parentId: string | null }>();
  const topics: { id: string; x: number; y: number; width: number; height: number; topic: number }[] = [];
  forest.forEach((tree, topic) => {
    const lane = bottoms.indexOf(Math.min(...bottoms));
    const x = lane * laneWidth, y = bottoms[lane];
    const flat: typeof tree[] = [];
    const visit = (t: typeof tree) => { flat.push(t); t.children.forEach(visit); };
    visit(tree);
    flat.forEach((t, i) => positions.set(t.node.id, {
      x: x + 5 + (i % columns) * (width + gap), y: y + 26 + Math.floor(i / columns) * (height + rowGap),
      width, height, topic, parentId: t.node.parentId,
    }));
    const boxHeight = 28 + Math.ceil(flat.length / columns) * (height + rowGap);
    topics.push({ id: tree.node.id, x, y, width: laneWidth - 6, height: boxHeight, topic });
    bottoms[lane] += boxHeight + 8;
  });
  return { positions, topics };
}
