import { describe, expect, it } from "bun:test";
import { clockLabel, dayDividerLabel, memoryWritesOf, sameLocalDay } from "./role-timeline";
import type { ToolCall } from "./types";

const HOME = "/home/u/.trellis/roles/laozhou";

function call(name: string, file_path: string, status: ToolCall["status"] = "done"): ToolCall {
  return {
    id: `${name}-${file_path}`,
    name,
    input: { file_path },
    output: null,
    stderr: null,
    status,
    durationMs: 1,
    startedAt: 0,
    endedAt: 1,
  };
}

describe("dayDividerLabel", () => {
  const now = new Date(2026, 9, 30, 10, 0).getTime(); // 2026-10-30 周五
  it("今天 / 昨天 / 具体日期", () => {
    expect(dayDividerLabel(new Date(2026, 9, 30, 0, 5).getTime(), now)).toBe("今天");
    expect(dayDividerLabel(new Date(2026, 9, 29, 23, 59).getTime(), now)).toBe("昨天");
    expect(dayDividerLabel(new Date(2026, 9, 28, 21, 14).getTime(), now)).toBe("10 月 28 日 周三");
  });
  it("跨年带年份", () => {
    expect(dayDividerLabel(new Date(2025, 11, 31, 9, 0).getTime(), now)).toBe("2025 年 12 月 31 日 周三");
  });
});

describe("sameLocalDay / clockLabel", () => {
  it("按本地日历日比较", () => {
    expect(sameLocalDay(new Date(2026, 9, 30, 0, 1).getTime(), new Date(2026, 9, 30, 23, 59).getTime())).toBe(true);
    expect(sameLocalDay(new Date(2026, 9, 29, 23, 59).getTime(), new Date(2026, 9, 30, 0, 1).getTime())).toBe(false);
  });
  it("两位补零", () => {
    expect(clockLabel(new Date(2026, 9, 30, 9, 5).getTime())).toBe("09:05");
  });
});

describe("memoryWritesOf", () => {
  it("只认记忆目录下的 Write / Edit / MultiEdit，已完成的，按文件去重取第一次", () => {
    const writes = memoryWritesOf(
      {
        toolCalls: [
          call("Read", `${HOME}/memories/a.md`),
          call("Write", `${HOME}/memories/a.md`),
          call("Edit", `${HOME}/memories/a.md`),
          call("Edit", `${HOME}/MEMORY.md`),
          call("Edit", `${HOME}/memories/b.md`),
          call("Write", `${HOME}/memories/c.md`, "running"),
          call("Write", "/tmp/memories/d.md"),
        ],
      },
      HOME,
    );
    expect(writes).toEqual([
      { path: `${HOME}/memories/a.md`, file: "a.md", tool: "Write" },
      { path: `${HOME}/memories/b.md`, file: "b.md", tool: "Edit" },
    ]);
  });

  it("toolCalls 没拉回来时退回 generatedFiles，tool 未知", () => {
    const writes = memoryWritesOf(
      {
        toolCalls: [],
        generatedFiles: [
          { absPath: `${HOME}/memories/a.md`, name: "a.md" },
          { absPath: `${HOME}/USER.md`, name: "USER.md" },
        ],
      },
      HOME,
    );
    expect(writes).toEqual([{ path: `${HOME}/memories/a.md`, file: "a.md", tool: null }]);
  });

  it("homeDir 带尾斜杠也认", () => {
    expect(memoryWritesOf({ toolCalls: [call("Write", `${HOME}/memories/x.md`)] }, `${HOME}/`)).toHaveLength(1);
  });
});
