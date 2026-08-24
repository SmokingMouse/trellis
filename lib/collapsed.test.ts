import { describe, expect, it } from "bun:test";
import {
  ancestorsOf,
  hiddenByCollapse,
  hiddenCanvasNodeIds,
  descendantCount,
  subtreeIds,
} from "./collapsed";
import type { ChatNode } from "./types";

function mockNode(
  id: string,
  parentId: string | null,
  hiddenAt: number | null = null,
): ChatNode {
  return {
    id,
    sessionId: "s1",
    parentId,
    parentAnchor: null,
    question: `Q ${id}`,
    response: `A ${id}`,
    status: "done",
    errorMessage: null,
    position: { x: 0, y: 0 },
    tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    createdAt: 1000,
    siblingIndex: 0,
    topicLabel: null,
    kind: "qa",
    reference: null,
    readAt: null,
    attachments: [],
    toolCalls: [],
    pendingInteraction: null,
    hiddenAt,
  };
}

describe("collapsed", () => {
  const nodes: Record<string, ChatNode> = {
    // Tree 1: visible, 1 -> 2 -> 3
    r1: mockNode("r1", null),
    n2: mockNode("n2", "r1"),
    n3: mockNode("n3", "n2"),
    // Tree 2: hidden tree (hiddenAt set on root), h1 -> h2
    h1: mockNode("h1", null, 12345),
    h2: mockNode("h2", "h1"),
  };

  it("ancestorsOf returns parents in order to root", () => {
    expect(ancestorsOf("n3", nodes)).toEqual(["n2", "r1"]);
    expect(ancestorsOf("r1", nodes)).toEqual([]);
  });

  it("hiddenByCollapse only hides descendants of collapsed node", () => {
    const hidden = hiddenByCollapse(["n2"], nodes);
    expect(hidden.has("n3")).toBe(true);
    expect(hidden.has("n2")).toBe(false);
    expect(hidden.has("r1")).toBe(false);
    expect(hidden.has("h1")).toBe(false);
  });

  it("hiddenCanvasNodeIds hides both collapsed descendants and entire hidden trees", () => {
    // No collapsed nodes: hidden tree h1 and its child h2 should be hidden; r1, n2, n3 visible
    const hidden1 = hiddenCanvasNodeIds([], nodes);
    expect(hidden1.has("h1")).toBe(true);
    expect(hidden1.has("h2")).toBe(true);
    expect(hidden1.has("r1")).toBe(false);
    expect(hidden1.has("n2")).toBe(false);
    expect(hidden1.has("n3")).toBe(false);

    // Collapsed n2: h1, h2 (from hidden tree) + n3 (from collapsed n2) should be hidden
    const hidden2 = hiddenCanvasNodeIds(["n2"], nodes);
    expect(hidden2.has("h1")).toBe(true);
    expect(hidden2.has("h2")).toBe(true);
    expect(hidden2.has("n3")).toBe(true);
    expect(hidden2.has("r1")).toBe(false);
    expect(hidden2.has("n2")).toBe(false);
  });

  it("descendantCount and subtreeIds calculate correctly", () => {
    expect(descendantCount("r1", nodes)).toBe(2);
    expect(descendantCount("n2", nodes)).toBe(1);
    expect(descendantCount("n3", nodes)).toBe(0);

    expect(subtreeIds("r1", nodes).sort()).toEqual(["n2", "n3", "r1"]);
    expect(subtreeIds("n2", nodes).sort()).toEqual(["n2", "n3"]);
  });
});
