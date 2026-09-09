import { expect, test } from "bun:test";
import { layoutMap, normalizeViewMode, migrateMapUrl, mapCompact, mapViewport, MAP_RANK_GAP, MAP_TOPIC_HEADER, MAP_COMPACT_ZOOM, shouldFitMap, MAP_FIT_OPTIONS } from "./canvas-map";
import type { ChatNode } from "./types";

test("fitView waits for measurement, runs on every new map mount, session or viewport", () => {
  expect(shouldFitMap(false, "a:mobile", null)).toBe(false);
  expect(shouldFitMap(true, "a:mobile", null)).toBe(true);
  expect(shouldFitMap(true, "a:mobile", "a:mobile")).toBe(false);
  expect(shouldFitMap(true, "a:desktop", "a:mobile")).toBe(true);
  expect(shouldFitMap(true, "b:mobile", "a:mobile")).toBe(true);
  expect(MAP_FIT_OPTIONS.minZoom).toBeLessThan(0.2);
});

const fixture = (parents: (number | null)[]) => Object.fromEntries(parents.map((parent, i) => [String(i), {
  id: String(i), parentId: parent === null ? null : String(parent), question: `节点 ${i}`,
  createdAt: i, siblingIndex: i, hiddenAt: null,
} as ChatNode]));

test("six-node chain fits readably on desktop and phone, single topic fills viewport", () => {
  for (const viewport of [{ width: 1390, height: 770 }, { width: 390, height: 760 }]) {
    const model = layoutMap(fixture([null, 0, 1, 2, 3, 4]), viewport.width < 768, viewport);
    const fit = mapViewport(model.bounds, viewport);
    expect(fit.zoom).toBeGreaterThanOrEqual(0.9);
    expect(mapCompact(fit.zoom)).toBe(false);
    expect(model.bounds.width * fit.zoom).toBeCloseTo(viewport.width - 32);
    expect(model.bounds.height * fit.zoom).toBeCloseTo(viewport.height - 32);
    for (const edge of model.edges) {
      const parent = model.positions.get(edge.source)!;
      const child = model.positions.get(edge.target)!;
      expect(child.x).toBe(parent.x);
      expect(child.y - parent.y - parent.height).toBe(MAP_RANK_GAP);
    }
  }
});

test("fit maximizes readable zoom when possible, shrinks large maps and centers offsets", () => {
  for (const width of [400, 900, 2000]) {
    const bounds = { x: 50, y: 80, width, height: 600 };
    const viewport = { width: 1000, height: 800 };
    const fit = mapViewport(bounds, viewport);
    expect(fit.zoom).toBeCloseTo(Math.min(1.4, 968 / width, 768 / 600));
    expect(fit.x + (bounds.x + width / 2) * fit.zoom).toBeCloseTo(500);
    expect(fit.y + (bounds.y + 300) * fit.zoom).toBeCloseTo(400);
    expect(mapCompact(fit.zoom)).toBe(width === 2000);
  }
});

test("branching trees have fixed ranks, siblings abreast, edges at bottom/top and no card/header intersections", () => {
  const nodes = fixture([null, 0, 0, 1, 1, 2, 3, 5, null, 8, 8, 10]);
  for (const mobile of [false, true]) {
    const model = layoutMap(nodes, mobile);
    expect(model.edges.length).toBe(10);
    expect(model.positions.get("1")!.y).toBe(model.positions.get("2")!.y);
    for (const edge of model.edges) {
      const parent = model.positions.get(edge.source)!;
      const child = model.positions.get(edge.target)!;
      expect(parent.topic).toBe(child.topic);
      expect(child.y - parent.y - parent.height).toBe(MAP_RANK_GAP);
      expect(edge.points[0]).toEqual({ x: parent.x + parent.width / 2, y: parent.y + parent.height });
      expect(edge.points.at(-1)).toEqual({ x: child.x + child.width / 2, y: child.y });
      const obstacles = [...model.positions.values(), ...model.topics.map(t => ({ ...t, height: MAP_TOPIC_HEADER }))];
      edge.points.slice(1).forEach((b, i) => {
        const a = edge.points[i];
        for (const r of obstacles) {
          const crosses = a.x === b.x
            ? a.x > r.x && a.x < r.x + r.width && Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.height
            : a.y > r.y && a.y < r.y + r.height && Math.max(a.x, b.x) > r.x && Math.min(a.x, b.x) < r.x + r.width;
          expect(crosses).toBe(false);
        }
      });
    }
    // Different parent families cannot intersect; shared sibling stems are intentional.
    for (const edge of model.edges) for (const other of model.edges) {
      if (edge.source === other.source) continue;
      edge.points.slice(1).forEach((b, i) => other.points.slice(1).forEach((d, j) => {
        const a = edge.points[i], c = other.points[j];
        if (a.x === b.x && c.y === d.y) expect(a.x > Math.min(c.x, d.x) && a.x < Math.max(c.x, d.x) && c.y > Math.min(a.y, b.y) && c.y < Math.max(a.y, b.y)).toBe(false);
      }));
    }
  }
});

test("topic shelves reflow with viewport aspect ratio and remain disjoint", () => {
  const nodes = fixture(Array(9).fill(null));
  const wide = layoutMap(nodes, false, { width: 1440, height: 700 });
  const narrow = layoutMap(nodes, false, { width: 390, height: 844 });
  expect(wide.topics.filter(t => t.y === 0).length).toBeGreaterThan(narrow.topics.filter(t => t.y === 0).length);
  for (const model of [wide, narrow]) for (const a of model.topics) for (const b of model.topics) {
    if (a.id !== b.id) expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
  }
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
