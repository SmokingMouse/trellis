import { describe, expect, it } from "bun:test";
import type { GwNode } from "./gw-types";
import type { PendingItem } from "./pending";
import {
  buildNodeInbox,
  fanOut,
  groupSearch,
  isMultiNode,
  mergeInbox,
  otherNodes,
  sessionPath,
  sortInbox,
  type Fetcher,
  type InboxItem,
} from "./hub-fanout";

function node(name: string, over: Partial<GwNode> = {}): GwNode {
  return {
    name, kind: "remote", online: true, current: false, version: null, lastSeenAt: null, connectedAt: null,
    policy: { shareOut: true, acceptDispatch: true }, ...over,
  };
}

function pending(over: Partial<PendingItem> & { sessionId: string; nodeId: string }): PendingItem {
  return {
    sessionTitle: "pending 标题", kind: "approval", summary: "rm -rf build", createdAt: 100,
    interaction: { toolUseId: `t-${over.nodeId}`, toolName: "Bash", input: {} }, ...over,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("isMultiNode / otherNodes", () => {
  it("只有 home 时不算多机", () => {
    const nodes = [node("me", { kind: "home", current: true })];
    expect(isMultiNode(nodes)).toBe(false);
    expect(otherNodes(nodes)).toEqual([]);
    expect(otherNodes(null)).toEqual([]);
  });
  it("其他机器 = 非当前；当前在远端时 hub 本机也算其他", () => {
    const nodes = [node("me", { kind: "home" }), node("mini", { current: true }), node("office")];
    expect(otherNodes(nodes).map((n) => n.name)).toEqual(["me", "office"]);
  });
});

describe("fanOut", () => {
  it("离线不发请求；失败 / 超时 / 503 offline 各自隔离；顺序保持", async () => {
    const called: string[] = [];
    const fetcher: Fetcher = async (name, _path, init) => {
      called.push(name);
      if (name === "a") return json({ v: 1 });
      if (name === "b") return json({ error: "x" }, 500);
      if (name === "c") throw new Error("boom");
      if (name === "e") return json({ error: "离线", offline: true }, 503);
      // d：挂住直到被 abort
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };
    const nodes = [node("a"), node("b"), node("c"), node("d"), node("e"), node("off", { online: false })];
    const res = await fanOut<{ v: number }>(nodes, "/api/runs", { fetcher, timeoutMs: 20 });
    expect(called.sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(res).toEqual([
      { node: "a", status: "ok", data: { v: 1 } },
      { node: "b", status: "error", error: "HTTP 500" },
      { node: "c", status: "error", error: "boom" },
      { node: "d", status: "error", error: "超时" },
      { node: "e", status: "offline" },
      { node: "off", status: "offline" },
    ]);
  });
});

describe("buildNodeInbox", () => {
  const now = 10_000_000;
  const sessions = [
    { id: "s1", title: "审批会话", updatedAt: now - 1000 },
    { id: "s2", title: "在跑会话", updatedAt: now - 2000 },
    { id: "s3", title: "刚完成", updatedAt: now - 60_000 },
    { id: "s4", title: "很久以前", updatedAt: now - 3 * 3600_000 },
    { id: "s5", title: "归档的", updatedAt: now - 1000, archived: true },
  ];

  it("等待 > 在跑 > 刚完成；同一会话只出现一次；过期 / 归档不进刚完成", () => {
    const items = buildNodeInbox(
      "mini",
      {
        pending: { items: [pending({ sessionId: "s1", nodeId: "n1", createdAt: 500 })] },
        waitingNodes: [{ nodeId: "n1", sessionId: "s1" }],
        runningNodes: [{ nodeId: "n2", sessionId: "s2" }, { nodeId: "n1b", sessionId: "s1" }],
      },
      sessions,
      now,
    );
    expect(items.map((i) => [i.sessionId, i.status, i.nodeId, i.title])).toEqual([
      ["s1", "waiting", "n1", "审批会话"],
      ["s2", "running", "n2", "在跑会话"],
      ["s3", "done", null, "刚完成"],
    ]);
    expect(items[0].summary).toBe("rm -rf build");
  });

  it("没拿到 sessions 时用 pending 自带标题、没有刚完成", () => {
    const items = buildNodeInbox(
      "mini",
      { pending: { items: [pending({ sessionId: "x", nodeId: "n" })] }, runningNodes: [{ nodeId: "r", sessionId: "y" }] },
      undefined,
      now,
    );
    expect(items.map((i) => [i.title, i.status])).toEqual([["pending 标题", "waiting"], ["未命名会话", "running"]]);
  });

  it("刚完成每台最多 doneMax 条，最近在前", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, title: `d${i}`, updatedAt: now - i * 1000 }));
    const items = buildNodeInbox("m", {}, many, now, { doneMax: 2 });
    expect(items.map((i) => i.sessionId)).toEqual(["d0", "d1"]);
  });
});

describe("sortInbox / mergeInbox", () => {
  const it_ = (node: string, sessionId: string, status: InboxItem["status"], at: number): InboxItem =>
    ({ node, sessionId, nodeId: null, title: sessionId, status, at });

  it("跨机：等待最早在前，在跑 / 完成最近在前", () => {
    const sorted = sortInbox([
      it_("b", "done-old", "done", 1), it_("a", "run-new", "running", 9), it_("b", "wait-late", "waiting", 5),
      it_("a", "wait-early", "waiting", 2), it_("a", "done-new", "done", 8), it_("b", "run-old", "running", 3),
    ]);
    expect(sorted.map((i) => i.sessionId)).toEqual(["wait-early", "wait-late", "run-new", "run-old", "done-new", "done-old"]);
  });

  it("失败 / 离线的机器单列，不影响其它机器的条目", () => {
    const { items, unavailable } = mergeInbox([
      { node: "a", status: "ok", items: [it_("a", "s", "running", 1)] },
      { node: "b", status: "offline" },
      { node: "c", status: "error", error: "超时" },
    ]);
    expect(items.map((i) => i.sessionId)).toEqual(["s"]);
    expect(unavailable.map((n) => n.node)).toEqual(["b", "c"]);
  });
});

describe("sessionPath", () => {
  it("落到 app/page.tsx 的深链", () => {
    expect(sessionPath("s 1", "n/2")).toBe("/?session=s+1&node=n%2F2");
    expect(sessionPath("s1")).toBe("/?session=s1");
  });
});

describe("groupSearch", () => {
  it("本机在前；远端无命中整组省略；离线 / 出错保留", () => {
    const groups = groupSearch<string>({ node: "me", results: ["l1"] }, [
      { node: "a", status: "ok", data: { results: [] } },
      { node: "b", status: "ok", data: { results: ["b1", "b2"] } },
      { node: "c", status: "offline" },
      { node: "d", status: "error", error: "HTTP 502" },
    ]);
    expect(groups).toEqual([
      { node: "me", local: true, status: "ok", results: ["l1"] },
      { node: "b", local: false, status: "ok", results: ["b1", "b2"] },
      { node: "c", local: false, status: "offline", error: undefined },
      { node: "d", local: false, status: "error", error: "HTTP 502" },
    ]);
  });
});
