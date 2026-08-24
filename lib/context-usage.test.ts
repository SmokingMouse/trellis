import { describe, expect, test } from "bun:test";
import { ctxTokensOf, findLineageCtxTurn, isContextCompacted } from "./context-usage";

type ContextNode = Parameters<typeof ctxTokensOf>[0];

function node(
  id: string,
  parentId: string | null,
  tokenCount: Partial<ContextNode["tokenCount"]> = {},
  createdAt = 0,
): ContextNode {
  return {
    id,
    parentId,
    createdAt,
    tokenCount: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      ...tokenCount,
    },
  };
}

describe("Header context usage", () => {
  const nodes = {
    root: node("root", null, { contextTokens: 100 }, 1),
    a: node("a", "root", { contextTokens: 200 }, 2),
    aTip: node("aTip", "a", {}, 3),
    b: node("b", "root", { contextTokens: 300 }, 4),
    bTip: node("bTip", "b", { contextTokens: 400 }, 5),
  };

  test("uses the active branch and ignores newer sibling descendants", () => {
    expect(findLineageCtxTurn("aTip", nodes)?.id).toBe("a");
    expect(findLineageCtxTurn("bTip", nodes)?.id).toBe("bTip");
  });

  test("falls back to the nearest ancestor and hides an empty lineage", () => {
    expect(findLineageCtxTurn("aTip", nodes)?.id).toBe("a");
    expect(findLineageCtxTurn("empty", { empty: node("empty", null) })).toBeNull();
  });

  test("stops safely if corrupt parent data contains a cycle", () => {
    const cyclic = {
      a: node("a", "b"),
      b: node("b", "a"),
    };
    expect(findLineageCtxTurn("a", cyclic)).toBeNull();
  });

  test("prefers contextTokens and preserves the legacy bucket fallback", () => {
    expect(
      ctxTokensOf(
        node("current", null, {
          input: 20,
          cacheRead: 30,
          cacheCreation: 40,
          contextTokens: 10,
        }),
      ),
    ).toBe(10);
    expect(
      ctxTokensOf(
        node("legacy", null, {
          input: 20,
          output: 999,
          cacheRead: 30,
          cacheCreation: 40,
        }),
      ),
    ).toBe(90);
  });

  describe("isContextCompacted", () => {
    test("detects continuation summary marker in question", () => {
      const summaryNode = {
        question:
          "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.",
        tokenCount: { input: 1000, output: 200, cacheRead: 0, cacheCreation: 0 },
      };
      expect(isContextCompacted(summaryNode)).toBe(true);
    });

    test("detects context occupancy plunge", () => {
      const prev = {
        question: "Previous long turn",
        tokenCount: { input: 100, output: 200, cacheRead: 0, cacheCreation: 0, contextTokens: 120_000 },
      };
      const curr = {
        question: "Next turn after compact",
        tokenCount: { input: 100, output: 200, cacheRead: 0, cacheCreation: 0, contextTokens: 25_000 },
      };
      expect(isContextCompacted(curr, prev)).toBe(true);
    });

    test("returns false for normal consecutive turns", () => {
      const prev = {
        question: "Step 1",
        tokenCount: { input: 100, output: 200, cacheRead: 0, cacheCreation: 0, contextTokens: 30_000 },
      };
      const curr = {
        question: "Step 2",
        tokenCount: { input: 100, output: 200, cacheRead: 0, cacheCreation: 0, contextTokens: 35_000 },
      };
      expect(isContextCompacted(curr, prev)).toBe(false);
    });
  });
});
