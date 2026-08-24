import { describe, expect, test } from "bun:test";
import { formatTokens, computeToolActiveDuration } from "./format-tokens";
import { formatDuration } from "./format-duration";
import type { ToolCall } from "@/lib/types";

describe("formatTokens precision", () => {
  test("exact numbers under 1000", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(999)).toBe("999");
  });

  test("thousands with one decimal precision up to 1M", () => {
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1200)).toBe("1.2k");
    expect(formatTokens(12400)).toBe("12.4k");
    expect(formatTokens(45600)).toBe("45.6k");
    expect(formatTokens(100000)).toBe("100k");
    expect(formatTokens(125400)).toBe("125.4k");
    expect(formatTokens(999900)).toBe("999.9k");
  });

  test("millions with up to 2 decimal places", () => {
    expect(formatTokens(1000000)).toBe("1M");
    expect(formatTokens(1200000)).toBe("1.2M");
    expect(formatTokens(1250000)).toBe("1.25M");
  });

  test("edge cases", () => {
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(NaN)).toBe("—");
    expect(formatTokens(Infinity)).toBe("—");
  });
});

describe("formatDuration", () => {
  test("sub-second in milliseconds", () => {
    expect(formatDuration(450)).toBe("450 ms");
  });

  test("seconds under one minute", () => {
    expect(formatDuration(1200)).toBe("1.2 s");
    expect(formatDuration(45600)).toBe("45.6 s");
  });

  test("minutes and seconds", () => {
    expect(formatDuration(75000)).toBe("1m 15s");
  });
});

describe("computeToolActiveDuration", () => {
  test("empty or undefined toolCalls", () => {
    expect(computeToolActiveDuration([])).toBe(0);
    expect(computeToolActiveDuration(undefined)).toBe(0);
  });

  test("sequential top-level tool calls", () => {
    const tools: ToolCall[] = [
      {
        id: "t1",
        name: "Read",
        input: null,
        output: "ok",
        stderr: null,
        status: "done",
        startedAt: 1000,
        endedAt: 2000,
        durationMs: 1000,
      },
      {
        id: "t2",
        name: "Bash",
        input: null,
        output: "ok",
        stderr: null,
        status: "done",
        startedAt: 3000,
        endedAt: 8000,
        durationMs: 5000,
      },
    ];
    expect(computeToolActiveDuration(tools)).toBe(6000);
  });

  test("overlapping parallel tool calls merged without double-counting", () => {
    const tools: ToolCall[] = [
      {
        id: "t1",
        name: "Read",
        input: null,
        output: "ok",
        stderr: null,
        status: "done",
        startedAt: 1000,
        endedAt: 4000, // 3s
        durationMs: 3000,
      },
      {
        id: "t2",
        name: "WebFetch",
        input: null,
        output: "ok",
        stderr: null,
        status: "done",
        startedAt: 2000, // starts during t1
        endedAt: 6000,   // ends after t1
        durationMs: 4000,
      },
    ];
    // Combined interval [1000, 6000] = 5000ms
    expect(computeToolActiveDuration(tools)).toBe(5000);
  });

  test("ignores child tool calls with parentToolUseId", () => {
    const tools: ToolCall[] = [
      {
        id: "t1",
        name: "Agent",
        input: null,
        output: "ok",
        stderr: null,
        status: "done",
        startedAt: 1000,
        endedAt: 5000, // 4s
        durationMs: 4000,
      },
      {
        id: "child1",
        name: "Bash",
        input: null,
        output: "ok",
        stderr: null,
        status: "done",
        parentToolUseId: "t1",
        startedAt: 2000,
        endedAt: 4000,
        durationMs: 2000,
      },
    ];
    expect(computeToolActiveDuration(tools)).toBe(4000);
  });
});

describe("TPS calculation deducting tool execution", () => {
  test("pure chat turn without tools", () => {
    const outputTokens = 120;
    const durationMs = 2400; // 2.4s
    const toolDuration = computeToolActiveDuration([]);
    const llmDuration = durationMs - toolDuration;
    const tps = outputTokens / (llmDuration / 1000);
    expect(tps).toBe(50);
    expect(tps.toFixed(1)).toBe("50.0");
  });

  test("multi-step turn deducting slow tool calls", () => {
    const outputTokens = 200;
    const totalTurnMs = 60000; // 60s total turn
    const tools: ToolCall[] = [
      {
        id: "t1",
        name: "Bash",
        input: null,
        output: "done",
        stderr: null,
        status: "done",
        startedAt: 5000,
        endedAt: 60000, // 55s in bash
        durationMs: 55000,
      },
    ];
    const toolDuration = computeToolActiveDuration(tools);
    expect(toolDuration).toBe(55000);

    const llmDuration = totalTurnMs - toolDuration; // 5000ms = 5s
    expect(llmDuration).toBe(5000);

    const tps = outputTokens / (llmDuration / 1000);
    expect(tps).toBe(40);
    expect(tps.toFixed(1)).toBe("40.0");
  });
});
