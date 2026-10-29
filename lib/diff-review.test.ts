import { describe, expect, it } from "bun:test";
import {
  commentAnchor,
  formatReviewMessage,
  lastChangedTurn,
  snippetAt,
  toRepoRelative,
  turnChangedPaths,
  type ReviewComment,
} from "./diff-review";
import { parseUnifiedDiff } from "./unified-diff";
import type { ToolCall } from "./types";

const DIFF = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -40,4 +40,4 @@
 one
 two
-three
+THREE
 four
`;

const tc = (name: string, input: unknown): ToolCall => ({ id: name, name, input } as unknown as ToolCall);

describe("comment anchors and snippets", () => {
  const hunk = parseUnifiedDiff(DIFF)[0].hunks[0];

  it("anchors added/context lines on the new side and deleted lines on the old side", () => {
    expect(commentAnchor(hunk.lines[3])).toEqual({ side: "new", line: 42 });
    expect(commentAnchor(hunk.lines[2])).toEqual({ side: "old", line: 42 });
    expect(commentAnchor({ kind: "meta", text: "\\ No newline", oldNo: null, newNo: null })).toBeNull();
  });

  it("takes the commented line plus up to two lines before it", () => {
    expect(snippetAt(hunk, 3)).toBe(" two\n-three\n+THREE");
    expect(snippetAt(hunk, 0)).toBe(" one");
  });
});

describe("formatReviewMessage", () => {
  const base: Omit<ReviewComment, "id" | "path" | "line" | "body" | "createdAt"> = { side: "new", snippet: "+x" };

  it("sorts by path/line, uses path:line — body, and fences the snippet", () => {
    const msg = formatReviewMessage([
      { ...base, id: "2", path: "b.ts", line: 3, body: "second", createdAt: 2 },
      { ...base, id: "1", path: "a.ts", line: 42, body: "  rename this\nplease ", createdAt: 1 },
      { ...base, id: "3", path: "a.ts", line: 7, side: "old", body: "why removed?", createdAt: 3 },
      { ...base, id: "4", path: "c.ts", line: 1, body: "   ", createdAt: 4 },
    ]);
    expect(msg).toBe(
      [
        "请根据下面的代码审阅评论修改（共 3 条）：",
        "1. a.ts:7（已删除的旧行） — why removed?\n```diff\n+x\n```",
        "2. a.ts:42 — rename this\n   please\n```diff\n+x\n```",
        "3. b.ts:3 — second\n```diff\n+x\n```",
      ].join("\n\n"),
    );
  });

  it("lengthens the fence when the snippet contains backticks", () => {
    const msg = formatReviewMessage([
      { ...base, id: "1", path: "r.md", line: 1, body: "x", snippet: "+```js", createdAt: 1 },
    ]);
    expect(msg).toContain("````diff\n+```js\n````");
  });

  it("returns empty string when nothing to send", () => {
    expect(formatReviewMessage([])).toBe("");
  });
});

describe("turn changed files", () => {
  it("collects Write/Edit file_path and Codex changes from tool calls", () => {
    const paths = turnChangedPaths({
      toolCalls: [
        tc("Read", { file_path: "/r/x.ts" }),
        tc("Edit", { file_path: "/r/a.ts" }),
        tc("Write", { file_path: "/r/a.ts" }),
        tc("Edit", { changes: [{ path: "/r/b.ts" }] }),
        tc("Edit", { changes: { "/r/c.ts": {} } }),
      ],
      generatedFiles: [],
    });
    expect(paths).toEqual(["/r/a.ts", "/r/b.ts", "/r/c.ts"]);
  });

  it("falls back to server-precomputed generatedFiles", () => {
    expect(turnChangedPaths({ toolCalls: [], generatedFiles: [{ absPath: "/r/z.ts", name: "z.ts" }] })).toEqual(["/r/z.ts"]);
  });

  it("picks the most recent turn that changed files", () => {
    const n = (id: string, createdAt: number, files: string[]) => ({
      id,
      createdAt,
      toolCalls: [] as ToolCall[],
      generatedFiles: files.map((absPath) => ({ absPath, name: absPath })),
    });
    const hit = lastChangedTurn({ a: n("a", 1, ["/r/1"]), b: n("b", 3, []), c: n("c", 2, ["/r/2"]) });
    expect(hit?.node.id).toBe("c");
    expect(hit?.paths).toEqual(["/r/2"]);
    expect(lastChangedTurn([n("x", 1, [])])).toBeNull();
  });

  it("maps absolute paths to repo-relative", () => {
    expect(toRepoRelative("/repo/src/a.ts", "/repo/")).toBe("src/a.ts");
    expect(toRepoRelative("/repo2/a.ts", "/repo")).toBeNull();
  });
});
