import { describe, expect, it } from "bun:test";
import {
  attentionTitle,
  isHerdrWaiting,
  prioritySessions,
  stripAttentionPrefix,
  waitingSessionIds,
} from "./attention";

describe("attentionTitle", () => {
  it("prefixes (N) when sessions are waiting and restores at 0", () => {
    expect(attentionTitle("Trellis", 3)).toBe("(3) Trellis");
    expect(attentionTitle("Trellis", 0)).toBe("Trellis");
  });

  it("is idempotent: re-applying replaces the old count instead of stacking", () => {
    expect(attentionTitle("(3) Trellis", 1)).toBe("(1) Trellis");
    expect(attentionTitle("(3) Trellis", 0)).toBe("Trellis");
    expect(attentionTitle(attentionTitle("Trellis", 2), 2)).toBe("(2) Trellis");
  });

  it("only strips its own prefix, not parentheses inside the title", () => {
    expect(stripAttentionPrefix("Trellis (beta)")).toBe("Trellis (beta)");
    expect(stripAttentionPrefix("(dev)Trellis")).toBe("(dev)Trellis");
    expect(attentionTitle("(12) 会话 (2)", 4)).toBe("(4) 会话 (2)");
  });
});

describe("waitingSessionIds", () => {
  it("unions pending items and live waiting/blocked Herdr panes, skipping submissions", () => {
    const ids = waitingSessionIds(
      [
        { sessionId: "web-a", nodeId: "n1" },
        { sessionId: "web-a", nodeId: "n2" },
        { sessionId: "web-b", nodeId: "n3" },
      ],
      new Set(["n3"]),
      new Map([
        ["h-wait", { alive: true, status: "waiting" as const }],
        ["h-block", { alive: true, status: "blocked" as const }],
        ["h-dead", { alive: false, status: "waiting" as const }],
        ["h-work", { alive: true, status: "working" as const }],
      ]),
    );
    expect([...ids].sort()).toEqual(["h-block", "h-wait", "web-a"]);
  });

  it("treats offline panes as not waiting", () => {
    expect(isHerdrWaiting({ alive: false, status: "blocked" })).toBe(false);
    expect(isHerdrWaiting(undefined)).toBe(false);
  });
});

describe("prioritySessions", () => {
  it("puts waiting first, then unread, keeps input order and dedups", () => {
    const rows = prioritySessions(
      [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "b" }],
      new Set(["c"]),
      new Set(["a", "b", "c"]),
    );
    expect(rows.map((r) => `${r.session.id}:${r.reason}`)).toEqual(["c:waiting", "a:unread", "b:unread"]);
  });

  it("is empty when nothing needs attention", () => {
    expect(prioritySessions([{ id: "a" }], new Set(), new Set())).toEqual([]);
  });
});
