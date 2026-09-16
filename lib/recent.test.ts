import { describe, expect, it } from "bun:test";
import {
  chainStatus,
  deriveRecentChainStatus,
  groupRecentChains,
  groupSessionStructure,
  nodeLabel,
  orderRecentChains,
  recentSessionStatus,
  resolveSessionCollapsed,
  resolveTreeExpanded,
  toggleSessionCollapsedState,
  toggleTreeExpandedState,
  type RecentChainRow,
} from "./recent";

function row(over: Partial<RecentChainRow> & { tipId: string }): RecentChainRow {
  return {
    sessionId: "s1",
    sessionTitle: "会话一",
    sessionMode: "project",
    sessionWorkspacePath: "/tmp/w",
    rootId: "r1",
    nodeIds: ["r1", over.tipId],
    depth: 2,
    activityAt: 1000,
    tipQuestion: `问题 ${over.tipId}`,
    tipTopicLabel: null,
    tipKind: "qa",
    tipRefTitle: null,
    tipStatus: "done",
    tipReadAt: 1,
    tipWaiting: false,
    rootQuestion: "根问题",
    rootTopicLabel: "树名",
    rootKind: "qa",
    rootRefTitle: null,
    ...over,
  };
}

describe("nodeLabel", () => {
  it("prefers topicLabel, then reference title, then a question prefix", () => {
    expect(
      nodeLabel({ question: "x", topicLabel: "话题", kind: "qa", refTitle: null }),
    ).toBe("话题");
    expect(
      nodeLabel({ question: "", topicLabel: null, kind: "reference", refTitle: "材料" }),
    ).toBe("材料");
    expect(
      nodeLabel({ question: "", topicLabel: null, kind: "reference", refTitle: null }),
    ).toBe("参考材料");
    expect(
      nodeLabel({ question: "a".repeat(50), topicLabel: null, kind: "qa", refTitle: null }, 10),
    ).toBe("aaaaaaaaa…");
    expect(nodeLabel({ question: "  ", topicLabel: null, kind: "qa", refTitle: null })).toBe(
      "（空）",
    );
    expect(
      nodeLabel({ question: "周次\n开发任务\n\n2026", topicLabel: null, kind: "qa", refTitle: null }),
    ).toBe("周次 开发任务 2026");
  });
});

describe("chainStatus", () => {
  it("uses the tip baseline: waiting > streaming > error > unread > done", () => {
    expect(
      chainStatus({ tipStatus: "streaming", tipReadAt: null, tipWaiting: true }),
    ).toBe("waiting");
    expect(
      chainStatus({ tipStatus: "streaming", tipReadAt: null, tipWaiting: false }),
    ).toBe("streaming");
    expect(
      chainStatus({ tipStatus: "error", tipReadAt: null, tipWaiting: false }),
    ).toBe("error");
    expect(
      chainStatus({ tipStatus: "done", tipReadAt: null, tipWaiting: false }),
    ).toBe("unread");
    expect(
      chainStatus({ tipStatus: "done", tipReadAt: 1, tipWaiting: false }),
    ).toBe("done");
  });
});

describe("recent live status", () => {
  it("marks a chain streaming when a middle node is running", () => {
    const [session] = groupRecentChains(
      [row({ tipId: "tip", nodeIds: ["root", "middle", "tip"] })],
      new Map(),
    );
    expect(
      deriveRecentChainStatus(
        session.chains[0],
        new Set(["middle"]),
        new Set(),
      ),
    ).toBe("streaming");
  });

  it("keeps two chains in one session independent", () => {
    const [session] = groupRecentChains(
      [
        row({ tipId: "a", nodeIds: ["root", "a-mid", "a"] }),
        row({ tipId: "b", nodeIds: ["root", "b-mid", "b"] }),
      ],
      new Map(),
    );
    const statuses = session.chains.map((chain) =>
      deriveRecentChainStatus(chain, new Set(["a-mid"]), new Set()),
    );
    expect(statuses).toEqual(["streaming", "done"]);
  });

  it("aggregates a session with waiting > streaming > error > unread > done", () => {
    const [session] = groupRecentChains(
      [
        row({ tipId: "error", nodeIds: ["root", "error"], tipStatus: "error" }),
        row({ tipId: "run", nodeIds: ["root", "run"] }),
        row({ tipId: "wait", nodeIds: ["root", "wait"] }),
      ],
      new Map(),
    );
    expect(
      recentSessionStatus(
        session.chains,
        new Set(["run"]),
        new Set(["wait"]),
      ),
    ).toBe("waiting");
    expect(
      recentSessionStatus(session.chains, new Set(["run"]), new Set()),
    ).toBe("streaming");
    expect(recentSessionStatus(session.chains, new Set(), new Set())).toBe(
      "error",
    );
  });

  it("promotes an active older chain before the per-session cutoff", () => {
    const [session] = groupRecentChains(
      [
        row({ tipId: "hot", nodeIds: ["root", "hot"], activityAt: 20 }),
        row({ tipId: "active-old", nodeIds: ["root", "active-old"], activityAt: 10 }),
      ],
      new Map(),
      {
        chainsPerSession: 1,
        runningNodeIds: new Set(["active-old"]),
      },
    );
    expect(session.chains.map((chain) => chain.tipId)).toEqual(["active-old"]);
    expect(session.moreChains).toBe(1);
  });

  it("preserves activity order when no lineage has a live run", () => {
    const chains = [
      row({ tipId: "new", activityAt: 30 }),
      row({ tipId: "unread", activityAt: 20, tipReadAt: null }),
      row({ tipId: "error", activityAt: 10, tipStatus: "error" }),
    ].map((item) => groupRecentChains([item], new Map())[0].chains[0]);
    expect(orderRecentChains(chains, new Set(), new Set()).map((c) => c.tipId)).toEqual([
      "new",
      "unread",
      "error",
    ]);
  });

  it("ignores a middle-node error when the read tip is done", () => {
    const [session] = groupRecentChains(
      [row({ tipId: "tip", nodeIds: ["middle-error", "tip"] })],
      new Map(),
    );
    expect(deriveRecentChainStatus(session.chains[0], new Set(), new Set())).toBe(
      "done",
    );
  });

  it("ignores a middle-node unread state when the tip is already read", () => {
    const [session] = groupRecentChains(
      [row({ tipId: "tip", nodeIds: ["middle-unread", "tip"], tipReadAt: 9 })],
      new Map(),
    );
    expect(deriveRecentChainStatus(session.chains[0], new Set(), new Set())).toBe(
      "done",
    );
  });

  it("keeps the session streaming when its active node is outside recent chains", () => {
    const [session] = groupRecentChains(
      [row({ tipId: "visible", nodeIds: ["root", "visible"] })],
      new Map(),
    );
    expect(
      recentSessionStatus(session.chains, new Set(["not-in-recent"]), new Set(), {
        running: true,
        unread: false,
      }),
    ).toBe("streaming");
  });

  it("keeps a streaming tip lit before the live node poll arrives", () => {
    const [session] = groupRecentChains(
      [row({ tipId: "tip", tipStatus: "streaming" })],
      new Map(),
    );
    expect(deriveRecentChainStatus(session.chains[0], new Set(), new Set())).toBe(
      "streaming",
    );
  });
});

describe("groupRecentChains", () => {
  it("groups ordered rows by session, keeping first-seen (hottest) order", () => {
    const rows = [
      row({ tipId: "a", sessionId: "s2", sessionTitle: "二", activityAt: 900 }),
      row({ tipId: "b", sessionId: "s1", activityAt: 800 }),
      row({ tipId: "c", sessionId: "s2", sessionTitle: "二", activityAt: 700 }),
    ];
    const out = groupRecentChains(rows, new Map());
    expect(out.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(out[0].activityAt).toBe(900);
    expect(out[0].chains.map((c) => c.tipId)).toEqual(["a", "c"]);
    expect(out[1].chains.map((c) => c.tipId)).toEqual(["b"]);
    // 缺 treeCounts 项按单树处理
    expect(out[0].treeCount).toBe(1);
  });

  it("caps sessions and chains per session, counting the overflow", () => {
    const rows = [
      row({ tipId: "a1", sessionId: "s1", activityAt: 9 }),
      row({ tipId: "a2", sessionId: "s1", activityAt: 8 }),
      row({ tipId: "a3", sessionId: "s1", activityAt: 7 }),
      row({ tipId: "b1", sessionId: "s2", activityAt: 6 }),
      row({ tipId: "c1", sessionId: "s3", activityAt: 5 }),
      row({ tipId: "a4", sessionId: "s1", activityAt: 4 }),
    ];
    const out = groupRecentChains(rows, new Map([["s1", 3]]), {
      sessions: 2,
      chainsPerSession: 2,
    });
    expect(out.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(out[0].chains.map((c) => c.tipId)).toEqual(["a1", "a2"]);
    expect(out[0].moreChains).toBe(2);
    expect(out[0].treeCount).toBe(3);
    expect(out[1].moreChains).toBe(0);
  });

  it("carries labels, tree labels and status onto each chain", () => {
    const [s] = groupRecentChains(
      [row({ tipId: "t", tipTopicLabel: "尾巴", tipReadAt: null, depth: 4 })],
      new Map(),
    );
    expect(s.chains[0]).toMatchObject({
      tipId: "t",
      rootId: "r1",
      label: "尾巴",
      treeLabel: "树名",
      depth: 4,
      status: "unread",
    });
  });
});

describe("groupSessionStructure", () => {
  it("returns empty array for empty rows", () => {
    expect(groupSessionStructure([])).toEqual([]);
  });

  it("groups chains into trees and sorts trees & chains by activityAt DESC", () => {
    const rows = [
      // 树 1: 有两条链，较热链 activityAt=500，较冷链 activityAt=300
      row({ tipId: "t1-tip1", rootId: "r1", rootTopicLabel: "树1", activityAt: 500, nodeIds: ["r1", "n1", "t1-tip1"] }),
      row({ tipId: "t1-tip2", rootId: "r1", rootTopicLabel: "树1", activityAt: 300, nodeIds: ["r1", "n1", "t1-tip2"] }),
      // 树 2: 有一条链，activityAt=800
      row({ tipId: "t2-tip1", rootId: "r2", rootTopicLabel: "树2", activityAt: 800, nodeIds: ["r2", "t2-tip1"] }),
    ];

    const trees = groupSessionStructure(rows);
    // 树按 activity 降序：树 2 (800) 在前，树 1 (500) 在后
    expect(trees.map((t) => t.rootId)).toEqual(["r2", "r1"]);
    expect(trees[0].activityAt).toBe(800);
    expect(trees[1].activityAt).toBe(500);

    // 树 1 下的链按 activity 降序
    expect(trees[1].chains.map((c) => c.tipId)).toEqual(["t1-tip1", "t1-tip2"]);
    expect(trees[1].chains[0].activityAt).toBe(500);
    expect(trees[1].chains[1].activityAt).toBe(300);
  });

  it("accurately calculates nodeCount by deduplicating shared nodeIds", () => {
    const rows = [
      // r1 下有分支：["r1", "mid1", "leaf1"] 和 ["r1", "mid1", "leaf2"] 共 4 个节点
      row({ tipId: "leaf1", rootId: "r1", nodeIds: ["r1", "mid1", "leaf1"] }),
      row({ tipId: "leaf2", rootId: "r1", nodeIds: ["r1", "mid1", "leaf2"] }),
    ];
    const trees = groupSessionStructure(rows);
    expect(trees[0].nodeCount).toBe(4);
  });

  it("aggregates tree status by highest priority: waiting > streaming > error > unread > done", () => {
    const rows = [
      row({ tipId: "c-done", rootId: "r1", tipStatus: "done", tipReadAt: 10 }),
      row({ tipId: "c-unread", rootId: "r1", tipStatus: "done", tipReadAt: null }),
      row({ tipId: "c-err", rootId: "r1", tipStatus: "error" }),
    ];
    const trees = groupSessionStructure(rows);
    // 链包括 done, unread, error -> 树状态应为 error
    expect(trees[0].status).toBe("error");
  });

  it("derives live running and waiting statuses", () => {
    const rows = [
      row({ tipId: "c1", rootId: "r1", nodeIds: ["r1", "wait-node", "c1"] }),
      row({ tipId: "c2", rootId: "r2", nodeIds: ["r2", "run-node", "c2"] }),
    ];
    const trees = groupSessionStructure(rows, {
      waitingNodeIds: new Set(["wait-node"]),
      runningNodeIds: new Set(["run-node"]),
    });
    const t1 = trees.find((t) => t.rootId === "r1");
    const t2 = trees.find((t) => t.rootId === "r2");
    expect(t1?.status).toBe("waiting");
    expect(t1?.chains[0].status).toBe("waiting");
    expect(t2?.status).toBe("streaming");
    expect(t2?.chains[0].status).toBe("streaming");
  });
});

describe("resolveSessionCollapsed and resolveTreeExpanded (SN-1)", () => {
  it("defaults by tree count: multi-tree sessions expand to trees, single-tree collapse", () => {
    const emptyKeys = new Set<string>();
    // 多树会话 (treeCount > 1): 默认展开到树 (collapsed = false)
    expect(resolveSessionCollapsed("s-multi", 2, emptyKeys)).toBe(false);
    expect(resolveSessionCollapsed("s-multi", 5, emptyKeys)).toBe(false);

    // 单树会话 (treeCount <= 1): 默认折叠 (collapsed = true)
    expect(resolveSessionCollapsed("s-single", 1, emptyKeys)).toBe(true);
    expect(resolveSessionCollapsed("s-single", 0, emptyKeys)).toBe(true);

    // 树行自身默认折叠 (expanded = false)
    expect(resolveTreeExpanded("s-multi", "root1", emptyKeys)).toBe(false);
  });

  it("respects explicit expanded / collapsed preferences over treeCount default", () => {
    // 单树会话被显式展开
    const singleExpandedKeys = new Set(["session:expanded:s-single"]);
    expect(resolveSessionCollapsed("s-single", 1, singleExpandedKeys)).toBe(false);

    // 多树会话被显式折叠
    const multiCollapsedKeys = new Set(["session:collapsed:s-multi"]);
    expect(resolveSessionCollapsed("s-multi", 3, multiCollapsedKeys)).toBe(true);

    // 兼容 legacy session:id 键（视为折叠）
    const legacyKeys = new Set(["session:s-multi"]);
    expect(resolveSessionCollapsed("s-multi", 3, legacyKeys)).toBe(true);

    // 树行被显式展开
    const treeExpandedKeys = new Set(["tree:expanded:s-multi:root1"]);
    expect(resolveTreeExpanded("s-multi", "root1", treeExpandedKeys)).toBe(true);

    // 树行被显式折叠
    const treeCollapsedKeys = new Set(["tree:collapsed:s-multi:root1"]);
    expect(resolveTreeExpanded("s-multi", "root1", treeCollapsedKeys)).toBe(false);
  });

  it("toggles session collapsed state correctly and cleanly replaces opposite keys", () => {
    // 初始状态为折叠（比如单树默认折叠），toggle 后目标为展开 (collapsed=false)
    const afterExpand = toggleSessionCollapsedState("s1", true, ["other-key"]);
    expect(afterExpand).toContain("session:expanded:s1");
    expect(afterExpand).not.toContain("session:collapsed:s1");

    // 再次 toggle 后目标为折叠 (collapsed=true)
    const afterCollapse = toggleSessionCollapsedState("s1", false, afterExpand);
    expect(afterCollapse).toContain("session:collapsed:s1");
    expect(afterCollapse).not.toContain("session:expanded:s1");
    expect(afterCollapse).toContain("other-key");
  });

  it("toggles tree expanded state correctly and cleanly replaces opposite keys", () => {
    // 初始状态为折叠 (expanded=false)，toggle 后展开
    const afterExpand = toggleTreeExpandedState("s1", "r1", false, ["tree:collapsed:s1:r1"]);
    expect(afterExpand).toContain("tree:expanded:s1:r1");
    expect(afterExpand).not.toContain("tree:collapsed:s1:r1");

    // 再次 toggle 后折叠
    const afterCollapse = toggleTreeExpandedState("s1", "r1", true, afterExpand);
    expect(afterCollapse).toContain("tree:collapsed:s1:r1");
    expect(afterCollapse).not.toContain("tree:expanded:s1:r1");
  });
});
