import type { ChatNode } from "./types";

// Session-scoped node index: 1, 2, 3... in createdAt order. Used to give
// each card a stable short reference ("#7") so the user can scan / recall
// across the canvas, outline, and fullscreen view without remembering the
// question text. Pure derived — no schema, recomputed when nodes change.
export function buildNodeIndex(
  nodes: Record<string, ChatNode>,
): Record<string, number> {
  const result: Record<string, number> = {};
  Object.values(nodes)
    .sort((a, b) => a.createdAt - b.createdAt)
    .forEach((n, i) => {
      result[n.id] = i + 1;
    });
  return result;
}
