import type { ChatNode } from "./types";

function buildChildrenIndex(
  nodes: Record<string, ChatNode>,
): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const n of Object.values(nodes)) {
    if (!n.parentId) continue;
    const arr = m.get(n.parentId) ?? [];
    arr.push(n.id);
    m.set(n.parentId, arr);
  }
  return m;
}

export function ancestorsOf(
  nodeId: string,
  nodes: Record<string, ChatNode>,
): string[] {
  const out: string[] = [];
  let cur = nodes[nodeId];
  while (cur?.parentId) {
    out.push(cur.parentId);
    cur = nodes[cur.parentId];
  }
  return out;
}

// All node ids that should disappear from the canvas given a collapsed set.
// A collapsed node itself stays visible — only its descendants are hidden.
export function hiddenByCollapse(
  collapsed: Iterable<string>,
  nodes: Record<string, ChatNode>,
): Set<string> {
  const idx = buildChildrenIndex(nodes);
  const hidden = new Set<string>();
  const walk = (id: string) => {
    for (const k of idx.get(id) ?? []) {
      if (hidden.has(k)) continue;
      hidden.add(k);
      walk(k);
    }
  };
  for (const id of collapsed) walk(id);
  return hidden;
}

// Direct + indirect descendant count for a node — drives the "▶ N" / "▼ N"
// chip on cards and the muted suffix in Outline rows.
export function descendantCount(
  nodeId: string,
  nodes: Record<string, ChatNode>,
): number {
  const idx = buildChildrenIndex(nodes);
  let count = 0;
  const walk = (id: string) => {
    for (const k of idx.get(id) ?? []) {
      count++;
      walk(k);
    }
  };
  walk(nodeId);
  return count;
}
