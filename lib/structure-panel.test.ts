import { describe, expect, it } from "bun:test";
import { buildStructure, readStructurePreference, writeStructurePreference, structureKey, structureWidth, STRUCTURE_PREFERENCE_KEY } from "./structure-panel";
import type { ChatNode } from "./types";

function node(id: string, parentId: string | null, siblingIndex = 0, createdAt = 0): ChatNode {
  return { id, parentId, siblingIndex, createdAt, hiddenAt: null, question: id, topicLabel: null } as ChatNode;
}
const fixture = Object.fromEntries([
  node("r", null), node("a", "r", 0), node("a1", "a", 0),
  node("b", "r", 1), node("b1", "b", 0), node("b2", "b", 1),
  node("c", "r", 2), node("topic2", null, 0, 10),
].map(n => [n.id, n]));

describe("structure forest and reading position", () => {
  it("keeps every topic in stable order and builds recursive branches", () => {
    const m = buildStructure(fixture, "b");
    expect(m.forest.map(t => t.node.id)).toEqual(["r", "topic2"]);
    expect(m.current?.count).toBe(7);
    expect(m.current?.children[1].children.map(t => t.node.id)).toEqual(["b1", "b2"]);
    expect(m.branchCount).toBe(3);
  });
  it("matches the reading view's ancestors + anchor + first-child chain", () => {
    const m = buildStructure(fixture, "b");
    expect([...m.chain]).toEqual(["r", "b", "b1"]);
    expect(m.tipId).toBe("b1");
    expect(m.otherBranches.map(n => n.id)).toEqual(["a1", "b2", "c"]);
    // Every shortcut is a leaf, and selecting it removes only that chain.
    for (const n of m.otherBranches) {
      const selected = buildStructure(fixture, n.id);
      expect(selected.tipId).toBe(n.id);
      expect(selected.otherBranches.some(other => other.id === n.id)).toBe(false);
      expect(selected.otherBranches).toHaveLength(3);
    }
  });
  it("uses the primary root when the active node is missing", () => {
    expect(buildStructure(fixture, "removed", "topic2").current?.node.id).toBe("topic2");
    expect(buildStructure(fixture, null, "r").tipId).toBe("a1");
  });
  it("does not invent branches or an extra root for a single chain", () => {
    const m = buildStructure({ r: fixture.r, a: fixture.a, a1: fixture.a1 }, "a");
    expect(m.forest).toHaveLength(1);
    expect(m.otherBranches).toEqual([]);
    expect(m.branchCount).toBe(0);
  });
  it("retains hidden topics and floating references, and tolerates missing parents/cycles", () => {
    const hidden = { ...fixture.r, hiddenAt: 2 };
    const ref = { ...node("reference", null, 0, 12), kind: "reference" as const };
    expect(buildStructure({ ...fixture, r: hidden, reference: ref }, "a").forest).toHaveLength(3);
    expect(buildStructure({ orphan: node("orphan", "gone") }, "orphan").current?.node.id).toBe("orphan");
    expect(buildStructure({ x: node("x", "y"), y: node("y", "x") }, "x").chain.size).toBe(2);
    expect(buildStructure({}, null).forest).toEqual([]);
  });
});

describe("structure preferences", () => {
  it("defaults collapsed at 280px, restores both fields, and bounds width", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    expect(readStructurePreference(storage)).toEqual({ expanded: false, width: 280 });
    writeStructurePreference(storage, { expanded: true, width: 360 });
    expect(readStructurePreference(storage)).toEqual({ expanded: true, width: 360 });
    storage.setItem(STRUCTURE_PREFERENCE_KEY, '{"expanded":true,"width":900}');
    expect(readStructurePreference(storage)).toEqual({ expanded: true, width: 440 });
    expect(structureWidth(50)).toBe(240);
  });
  it("survives invalid JSON, wrong types and unavailable storage", () => {
    for (const value of ["broken", "null", '{"expanded":"false","width":"900"}']) {
      expect(readStructurePreference({ getItem: () => value })).toEqual({ expanded: false, width: 280 });
    }
    expect(readStructurePreference({ getItem: () => { throw Error("denied"); } }).expanded).toBe(false);
    expect(() => writeStructurePreference({ setItem: () => { throw Error("quota"); } }, { expanded: true, width: 280 })).not.toThrow();
  });
});

describe("structure keyboard", () => {
  const rows = [{ id: "r", parentId: null, expanded: true }, { id: "a", parentId: "r", expanded: false }, { id: "b", parentId: "r" }];
  it("moves focus without navigating, clamps ends and supports Home/End", () => {
    expect(structureKey("ArrowDown", rows, "r")).toEqual({ focus: "a" });
    expect(structureKey("ArrowUp", rows, "r")).toEqual({ focus: "r" });
    expect(structureKey("ArrowDown", rows, "b")).toEqual({ focus: "b" });
    expect(structureKey("Home", rows, "b")).toEqual({ focus: "r" });
    expect(structureKey("End", rows, "r")).toEqual({ focus: "b" });
  });
  it("expands/collapses or moves between parent and child", () => {
    expect(structureKey("ArrowRight", rows, "a")).toEqual({ toggle: "a" });
    expect(structureKey("ArrowRight", rows, "r")).toEqual({ focus: "a" });
    expect(structureKey("ArrowLeft", rows, "r")).toEqual({ toggle: "r" });
    expect(structureKey("ArrowLeft", rows, "b")).toEqual({ focus: "r" });
    // The unread filter may hide every child; Right must not enter the next topic.
    expect(structureKey("ArrowRight", [rows[0], { id: "other", parentId: null }], "r")).toEqual({});
  });
  it("Enter navigates, Esc closes, empty trees and unrelated keys are safe", () => {
    expect(structureKey("Enter", rows, "a")).toEqual({ jump: "a" });
    expect(structureKey("Escape", rows, "a")).toEqual({ close: true });
    expect(structureKey("x", rows, "a")).toEqual({});
    expect(structureKey("Enter", [], null)).toEqual({});
  });
});
