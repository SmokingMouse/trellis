import { expect, test } from "bun:test";
import { sessionSourceChip } from "./session-source";

test("来源 chip：自动化与飞书有标记，原生及 CLI user 不重复标记", () => {
  expect(sessionSourceChip({ kind: "herdr", origin: "native" })?.label).toBe("⚓");
  expect(sessionSourceChip({ kind: "user", origin: "herdr" })?.label).toBe("⚓");
  expect(sessionSourceChip({ kind: "task", origin: "native" })?.label).toBe("⏱");
  expect(sessionSourceChip({ kind: "lark", origin: "native" })?.label).toBe("💬");
  expect(sessionSourceChip({ origin: "lark" })?.label).toBe("💬");
  expect(sessionSourceChip({ kind: "user", origin: "native" })).toBeNull();
  expect(sessionSourceChip({ kind: "user", origin: "cli-import" })).toBeNull();
  expect(sessionSourceChip({})).toBeNull();
  expect(sessionSourceChip({ kind: "user", origin: "external", backend: "codex" })).toEqual({ label: "外部", title: "外部会话 · codex" });
  expect(sessionSourceChip({ origin: "external", backend: "claude" })?.title).toBe("外部会话 · claude");
});
