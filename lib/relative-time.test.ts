import { describe, expect, it } from "bun:test";
import { formatRelativeTime, formatRelativeTimeShort } from "./relative-time";

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0); // 2026-09-02T12:00Z

describe("formatRelativeTime", () => {
  it("buckets by minute / hour / day with the 前 suffix", () => {
    expect(formatRelativeTime(NOW - 5_000, NOW)).toBe("刚刚");
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe("5 分钟前");
    expect(formatRelativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3 小时前");
    expect(formatRelativeTime(NOW - 45 * 86_400_000, NOW)).toBe("45 天前");
  });

  it("clamps future timestamps to 刚刚 instead of going negative", () => {
    expect(formatRelativeTime(NOW + 60_000, NOW)).toBe("刚刚");
  });
});

describe("formatRelativeTimeShort", () => {
  it("drops the suffix and falls back to month/day after 30 days", () => {
    expect(formatRelativeTimeShort(NOW - 5_000, NOW)).toBe("刚刚");
    expect(formatRelativeTimeShort(NOW - 5 * 60_000, NOW)).toBe("5分钟");
    expect(formatRelativeTimeShort(NOW - 3 * 3_600_000, NOW)).toBe("3小时");
    expect(formatRelativeTimeShort(NOW - 3 * 86_400_000, NOW)).toBe("3天");
    const old = new Date(2026, 6, 15, 10, 0, 0).getTime(); // local 7/15
    expect(formatRelativeTimeShort(old, NOW)).toBe("7/15");
  });
});
