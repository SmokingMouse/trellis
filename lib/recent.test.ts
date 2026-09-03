import { describe, expect, it } from "bun:test";
import {
  chainStatus,
  deriveRecentChainStatus,
  groupRecentChains,
  nodeLabel,
  recentSessionStatus,
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
    hasError: false,
    hasUnread: false,
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
  it("uses the whole-lineage terminal baseline: error > unread > done", () => {
    expect(chainStatus({ hasError: true, hasUnread: true })).toBe("error");
    expect(chainStatus({ hasError: false, hasUnread: true })).toBe("unread");
    expect(chainStatus({ hasError: false, hasUnread: false })).toBe("done");
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
        row({ tipId: "error", nodeIds: ["root", "error"], hasError: true }),
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
      [row({ tipId: "t", tipTopicLabel: "尾巴", hasUnread: true, depth: 4 })],
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
