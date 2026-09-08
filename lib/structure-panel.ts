import { childrenIndex, nodeSort } from "./tree-panel";
import type { ChatNode } from "./types";

export const STRUCTURE_PANEL = process.env.NEXT_PUBLIC_TRELLIS_STRUCTURE_PANEL !== "off" && process.env.NEXT_PUBLIC_TRELLIS_STRUCTURE_PANEL !== "0";
export const STRUCTURE_PREFERENCE_KEY = "trellis-structure-panel";
export const DEFAULT_STRUCTURE_PREFERENCE = { expanded: false, width: 280 };
export function structureWidth(width: number) { return Math.min(440, Math.max(240, Math.round(width))); }
export function readStructurePreference(storage: Pick<Storage, "getItem">) {
  try {
    const value = JSON.parse(storage.getItem(STRUCTURE_PREFERENCE_KEY) ?? "null");
    return {
      expanded: typeof value?.expanded === "boolean" ? value.expanded : false,
      width: typeof value?.width === "number" && Number.isFinite(value.width) ? structureWidth(value.width) : 280,
    };
  } catch { return { ...DEFAULT_STRUCTURE_PREFERENCE }; }
}
export function writeStructurePreference(storage: Pick<Storage, "setItem">, value: typeof DEFAULT_STRUCTURE_PREFERENCE) {
  try { storage.setItem(STRUCTURE_PREFERENCE_KEY, JSON.stringify(value)); } catch { /* Private storage: retain session state. */ }
}

export interface StructureNode { node: ChatNode; children: StructureNode[]; count: number; leaves: ChatNode[] }
/** Stable chronological forest; heat ranking must not hide topics. */
export function buildStructure(nodes: Record<string, ChatNode>, activeId: string | null, primaryRootId?: string) {
  const children = childrenIndex(nodes);
  const attach = (node: ChatNode, seen = new Set<string>()): StructureNode => {
    const path = new Set(seen).add(node.id);
    const nested = (children.get(node.id) ?? []).filter(n => !path.has(n.id)).map(n => attach(n, path));
    return { node, children: nested, count: 1 + nested.reduce((n, c) => n + c.count, 0), leaves: nested.length ? nested.flatMap(c => c.leaves) : [node] };
  };
  const forest = Object.values(nodes).filter(n => !n.parentId || !nodes[n.parentId]).sort((a, b) => a.createdAt - b.createdAt || nodeSort(a, b)).map(n => attach(n));
  const anchor = (activeId && nodes[activeId]) || (primaryRootId && nodes[primaryRootId]) || forest.find(t => t.node.hiddenAt === null)?.node || forest[0]?.node;
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: ChatNode | undefined = anchor || undefined;
  while (cur && !seen.has(cur.id)) { chain.unshift(cur.id); seen.add(cur.id); cur = cur.parentId ? nodes[cur.parentId] : undefined; }
  cur = anchor ? children.get(anchor.id)?.[0] : undefined;
  while (cur && !seen.has(cur.id)) { chain.push(cur.id); seen.add(cur.id); cur = children.get(cur.id)?.[0]; }
  const current = forest.find(t => t.node.id === chain[0]);
  return { forest, current, chain: new Set(chain), tipId: chain.at(-1), otherBranches: current?.leaves.filter(n => n.id !== chain.at(-1)) ?? [], branchCount: forest.reduce((n, t) => n + Math.max(0, t.leaves.length - 1), 0) };
}

export interface StructureRow { id: string; parentId: string | null; expanded?: boolean }
/** Roving tree focus, with conventional left/right expand/parent/child behavior. */
export function structureKey(key: string, rows: StructureRow[], focused: string | null) {
  const i = Math.max(0, rows.findIndex(r => r.id === focused));
  const row = rows[i];
  if (!row) return {};
  if (key === "ArrowDown") return { focus: rows[Math.min(rows.length - 1, i + 1)].id };
  if (key === "ArrowUp") return { focus: rows[Math.max(0, i - 1)].id };
  if (key === "Home") return { focus: rows[0].id };
  if (key === "End") return { focus: rows.at(-1)!.id };
  if (key === "ArrowRight") return row.expanded === false ? { toggle: row.id } : row.expanded && rows[i + 1]?.parentId === row.id ? { focus: rows[i + 1].id } : {};
  if (key === "ArrowLeft") return row.expanded ? { toggle: row.id } : { focus: row.parentId ?? undefined };
  if (key === "Enter") return { jump: row.id };
  if (key === "Escape") return { close: true };
  return {};
}
