import { describe, expect, it } from "bun:test";
import { fileBaseName, groupFilesByDir, parseUnifiedDiff, unquoteGitPath } from "./unified-diff";

const MODIFIED = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@ export function main() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;

 console.log(a);
@@ -10,2 +11,2 @@
-old tail
+new tail
 end
\\ No newline at end of file
`;

describe("parseUnifiedDiff", () => {
  it("parses a modified file into hunks with line numbers", () => {
    const [f] = parseUnifiedDiff(MODIFIED);
    expect(f.path).toBe("src/app.ts");
    expect(f.status).toBe("M");
    expect(f.additions).toBe(3);
    expect(f.deletions).toBe(2);
    expect(f.hunks).toHaveLength(2);

    const h = f.hunks[0];
    expect(h.section).toBe("export function main() {");
    expect(h.lines.map((l) => l.kind)).toEqual(["ctx", "del", "add", "add", "ctx", "ctx"]);
    expect(h.lines[1]).toEqual({ kind: "del", text: "const b = 2;", oldNo: 2, newNo: null });
    expect(h.lines[3]).toEqual({ kind: "add", text: "const c = 4;", oldNo: null, newNo: 3 });
    // 被工具吃掉前导空格的空上下文行仍按上下文计数
    expect(h.lines[4]).toEqual({ kind: "ctx", text: "", oldNo: 3, newNo: 4 });
    expect(h.lines[5].newNo).toBe(5);

    const h2 = f.hunks[1];
    expect(h2.lines[0]).toMatchObject({ kind: "del", oldNo: 10 });
    expect(h2.lines[1]).toMatchObject({ kind: "add", newNo: 11 });
    expect(h2.lines[3].kind).toBe("meta");
  });

  it("detects added, deleted, renamed and binary files", () => {
    const text = [
      "diff --git a/new.md b/new.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.md",
      "@@ -0,0 +1 @@",
      "+hello",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/old/name.ts b/new/name.ts",
      "similarity index 100%",
      "rename from old/name.ts",
      "rename to new/name.ts",
      "diff --git a/img.png b/img.png",
      "index 1..2 100644",
      "Binary files a/img.png and b/img.png differ",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(text);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["new.md", "A"],
      ["gone.txt", "D"],
      ["new/name.ts", "R"],
      ["img.png", "M"],
    ]);
    expect(files[0].hunks[0].lines[0]).toMatchObject({ kind: "add", newNo: 1 });
    expect(files[1].hunks[0].lines[0]).toMatchObject({ kind: "del", oldNo: 1 });
    expect(files[2].oldPath).toBe("old/name.ts");
    expect(files[2].hunks).toHaveLength(0);
    expect(files[3].binary).toBe(true);
  });

  it("handles paths with spaces and quoted unicode escapes", () => {
    const text = [
      "diff --git a/my dir/a b.txt b/my dir/a b.txt",
      "--- a/my dir/a b.txt",
      "+++ b/my dir/a b.txt",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      'diff --git "a/\\344\\270\\255.txt" "b/\\344\\270\\255.txt"',
      "new file mode 100644",
      "--- /dev/null",
      '+++ "b/\\344\\270\\255.txt"',
      "@@ -0,0 +1 @@",
      "+z",
    ].join("\n");
    const files = parseUnifiedDiff(text);
    expect(files.map((f) => f.path)).toEqual(["my dir/a b.txt", "中.txt"]);
  });

  it("tolerates truncated output and empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    const cut = MODIFIED.split("\n").slice(0, 7).join("\n") + "\n\n... (Diff 过长，已截断)";
    const [f] = parseUnifiedDiff(cut);
    expect(f.path).toBe("src/app.ts");
    expect(f.hunks[0].lines.some((l) => l.text.includes("截断"))).toBe(false);
  });
});

describe("helpers", () => {
  it("unquotes git C-style paths", () => {
    expect(unquoteGitPath('"a\\tb\\"c"')).toBe('a\tb"c');
    expect(unquoteGitPath("plain")).toBe("plain");
  });

  it("groups files by directory with root first", () => {
    const groups = groupFilesByDir([{ path: "z/b.ts" }, { path: "README.md" }, { path: "a/x.ts" }, { path: "z/a.ts" }]);
    expect(groups.map((g) => [g.dir, g.files.map((f) => f.path)])).toEqual([
      ["", ["README.md"]],
      ["a", ["a/x.ts"]],
      ["z", ["z/b.ts", "z/a.ts"]],
    ]);
    expect(fileBaseName("a/b/c.ts")).toBe("c.ts");
  });
});
