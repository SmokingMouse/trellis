import { describe, expect, test } from "bun:test";
import { ctxTokensOf, findLineageCtxTurn } from "./context-usage";

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
});
