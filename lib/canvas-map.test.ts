import { expect, test } from "bun:test";
import { layoutMap, normalizeViewMode, migrateMapUrl, mapCompact, MAP_COMPACT_ZOOM, shouldFitMap, MAP_FIT_OPTIONS } from "./canvas-map";
import type { ChatNode } from "./types";

test("fitView waits for measurement, runs on every new map mount, session or viewport", () => {
  expect(shouldFitMap(false, "a:mobile", null)).toBe(false);
  expect(shouldFitMap(true, "a:mobile", null)).toBe(true);
  expect(shouldFitMap(true, "a:mobile", "a:mobile")).toBe(false);
  expect(shouldFitMap(true, "a:desktop", "a:mobile")).toBe(true);
  expect(shouldFitMap(true, "b:mobile", "a:mobile")).toBe(true);
  expect(MAP_FIT_OPTIONS.minZoom).toBeLessThan(0.2);
});
test("overview threshold retains topic blocks; details are independent of zoom", () => {
  expect(mapCompact(0.1)).toBe(true);
  expect(mapCompact(MAP_COMPACT_ZOOM - 0.001)).toBe(true);
  expect(mapCompact(MAP_COMPACT_ZOOM)).toBe(false);
});
test("old URLs and stored canvas values migrate to linear, rollback retains legacy", () => {
  for (const v of ["canvas", "linear", undefined, "unknown"]) expect(normalizeViewMode(v, true)).toBe("linear");
  expect(normalizeViewMode("canvas", false)).toBe("canvas");
  expect(normalizeViewMode("unknown", false)).toBeUndefined();
  const url = new URL("https://example.test/?session=s&node=n&view=canvas&viewMode=canvas&mode=chat#anchor");
  expect(migrateMapUrl(new URL(url), false).href).toBe(url.href);
  expect(migrateMapUrl(url, true).search).toBe("?session=s&node=n&mode=chat");
  expect(url.hash).toBe("#anchor");
});
test("124 nodes in 10 trees retain every node and parent with non-overlapping blocks", () => {
  const nodes: Record<string, ChatNode> = {};
  for (let i = 0; i < 124; i++) {
    const id = String(i);
    nodes[id] = { id, parentId: i < 10 ? null : String(i - 10), hiddenAt: i === 0 ? 1 : null, question: id, createdAt: i, siblingIndex: 0 } as ChatNode;
  }
  for (const mobile of [false, true]) {
    const model = layoutMap(nodes, mobile);
    expect(model.positions.size).toBe(124);
    expect(model.topics.length).toBe(10);
    for (const [id, p] of model.positions) {
      expect(p.parentId).toBe(nodes[id].parentId);
      for (const [other, q] of model.positions) if (id !== other) {
        expect(p.x + p.width <= q.x || q.x + q.width <= p.x || p.y + p.height <= q.y || q.y + q.height <= p.y).toBe(true);
      }
    }
  }
});
