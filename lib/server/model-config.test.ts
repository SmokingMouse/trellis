import { afterAll, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

mock.module("server-only", () => ({}));
const { envFileKeys } = await import("./model-config");

const dir = mkdtempSync(path.join(tmpdir(), "trellis-model-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("envFileKeys：只认值非空的变量，支持 export 与引号", () => {
  const f = path.join(dir, "gw.env");
  writeFileSync(
    f,
    ["# comment", "DEEPSEEK_API_KEY=sk-1", "export GEMINI_API_KEY='g'", "EMPTY_KEY=", 'QUOTED_EMPTY=""', "  CPA_API_KEY = x  "].join("\n"),
  );
  expect([...envFileKeys(f)].sort()).toEqual(["CPA_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY"]);
  expect(envFileKeys(path.join(dir, "missing.env")).size).toBe(0);
});
