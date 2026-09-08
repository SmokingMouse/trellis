import { expect, test } from "bun:test";
import { formatBytes } from "./format-bytes";

test("machine resources retain GB until 1024 GB, then promote to TB", () => {
  expect(formatBytes(64 * 1024 ** 3)).toBe("64.0 GB");
  expect(formatBytes(926.4 * 1024 ** 3)).toBe("926.4 GB");
  expect(formatBytes(1024 ** 4 - 1)).toBe("1024.0 GB");
  expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
  expect(formatBytes(1.5 * 1024 ** 4)).toBe("1.5 TB");
  expect(formatBytes(1024 ** 2)).toBe("1.0 MB");
  expect(formatBytes(0)).toBe("0 B");
});
