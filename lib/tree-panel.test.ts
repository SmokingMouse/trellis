import { describe, expect, it } from "bun:test";
import {
  buildTreeEntries,
  groupTrees,
  treeLabel,
  type TreeEntry,
} from "./tree-panel";
import type { ChatNode } from "./types";

function makeMockNode(
  id: string,
  parentId: string | null,
  createdAt: number,
  topicLabel?: string,
  hiddenAt: number | null = null,
): ChatNode {
  return {
    id,
    sessionId: "sess_1",
    parentId,
    parentAnchor: null,
    question: `Question for ${id}`,
    response: `Response for ${id}`,
    status: "done",
    errorMessage: null,
    position: { x: 0, y: 0 },
    tokenCount: { input: 10, output: 20, cacheRead: 0, cacheCreation: 0 },
    createdAt,
    siblingIndex: 0,
    topicLabel: topicLabel ?? null,
    kind: "qa",
    reference: null,
    readAt: createdAt,
    attachments: [],
    toolCalls: [],
    pendingInteraction: null,
    hiddenAt,
  };
}

describe("tree-panel", () => {
  it("builds entries and sorts by heat", () => {
    const nodes: Record<string, ChatNode> = {
      root1: makeMockNode("root1", null, 100, "Tree 1"),
      child1: makeMockNode("child1", "root1", 200),
      root2: makeMockNode("root2", null, 300, "Tree 2"),
    };
    const entries = buildTreeEntries(nodes);
    expect(entries.length).toBe(2);
    expect(entries[0].root.id).toBe("root2"); // heat 300
    expect(entries[1].root.id).toBe("root1"); // heat 200
  });

  it("marks hidden trees correctly in buildTreeEntries", () => {
    const nodes: Record<string, ChatNode> = {
      root1: makeMockNode("root1", null, 100, "Tree 1", 150),
      root2: makeMockNode("root2", null, 200, "Tree 2", null),
    };
    const entries = buildTreeEntries(nodes);
    expect(entries.find((e) => e.root.id === "root1")?.hidden).toBe(true);
    expect(entries.find((e) => e.root.id === "root2")?.hidden).toBe(false);
  });

  it("groupTrees puts hidden trees in hidden group only, even if active", () => {
    const entries: TreeEntry[] = [
      {
        root: makeMockNode("root1", null, 100, "Tree 1", 150),
        nodes: [makeMockNode("root1", null, 100, "Tree 1", 150)],
        count: 1,
        unreadCount: 0,
        heat: 100,
        latestNodeId: "root1",
        hidden: true,
        hasStreaming: false,
        hasWaiting: false,
      },
    ];

    // When only 1 tree exists and it is hidden and active
    const groups = groupTrees(entries, "root1", 5);
    expect(groups.hot.length).toBe(0);
    expect(groups.cold.length).toBe(0);
    expect(groups.hidden.length).toBe(1);
    expect(groups.hidden[0].root.id).toBe("root1");
  });

  it("groupTrees separates visible hot/cold and hidden trees correctly", () => {
    const entries: TreeEntry[] = [
      {
        root: makeMockNode("root1", null, 500, "Tree 1", null),
        nodes: [],
        count: 1,
        unreadCount: 0,
        heat: 500,
        latestNodeId: "root1",
        hidden: false,
        hasStreaming: false,
        hasWaiting: false,
      },
      {
        root: makeMockNode("root2", null, 400, "Tree 2", 450),
        nodes: [],
        count: 1,
        unreadCount: 0,
        heat: 400,
        latestNodeId: "root2",
        hidden: true,
        hasStreaming: false,
        hasWaiting: false,
      },
      {
        root: makeMockNode("root3", null, 300, "Tree 3", null),
        nodes: [],
        count: 1,
        unreadCount: 0,
        heat: 300,
        latestNodeId: "root3",
        hidden: false,
        hasStreaming: false,
        hasWaiting: false,
      },
    ];

    // Limit 1 so Tree 1 is hot, Tree 3 is cold, Tree 2 is hidden
    const groups = groupTrees(entries, "root3", 1);
    // Tree 3 is active and was in cold -> swapped into hot
    expect(groups.hot.map((e) => e.root.id)).toEqual(["root3"]);
    expect(groups.cold.map((e) => e.root.id)).toEqual(["root1"]);
    expect(groups.hidden.map((e) => e.root.id)).toEqual(["root2"]);
  });

  it("treeLabel formats correctly", () => {
    const n = makeMockNode("root1", null, 100, "My Label");
    expect(treeLabel(n)).toBe("My Label");

    const nNoTopic = makeMockNode("root2", null, 100, undefined);
    expect(treeLabel(nNoTopic)).toBe("Question for root2");

    const nRef = makeMockNode("root3", null, 100, undefined);
    nRef.kind = "reference";
    nRef.reference = {
      sourceType: "url",
      sourceUri: "https://example.com",
      fetchedAt: 100,
      contentMd: "content",
      meta: { title: "Ref Title" },
    };
    expect(treeLabel(nRef)).toBe("Ref Title");

    // When topicLabel is provided, it takes precedence even on reference nodes
    nRef.topicLabel = "Custom Ref Name";
    expect(treeLabel(nRef)).toBe("Custom Ref Name");
  });
});
