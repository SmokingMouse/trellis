import { describe, expect, test } from "bun:test";
import { memoryTitle } from "./roles";

describe("memoryTitle", () => {
  test("优先 description（人话），没有再退回 name（kebab slug）", () => {
    expect(memoryTitle({ name: "target-ielts-7", description: "目标雅思成绩 7 分" })).toBe("目标雅思成绩 7 分");
    expect(memoryTitle({ name: "target-ielts-7", description: "  " })).toBe("target-ielts-7");
    expect(memoryTitle({ name: "", description: "" })).toBe("");
  });
});
