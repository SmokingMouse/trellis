import { describe, expect, it } from "bun:test";
import { middleEllipsisPath } from "./run-config";

describe("middleEllipsisPath", () => {
  it("keeps short workspace paths unchanged", () => {
    expect(middleEllipsisPath("/tmp/trellis")).toBe("/tmp/trellis");
  });

  it("keeps both the source and workspace name on narrow screens", () => {
    const path = "/Users/smokingmouse/python/learning/trellis/worktrees/mobile-new-session";
    const compact = middleEllipsisPath(path, 30);
    expect(compact).toHaveLength(30);
    expect(compact.startsWith("/Users/smoking")).toBe(true);
    expect(compact.endsWith("new-session")).toBe(true);
    expect(compact).toContain("…");
  });
});
