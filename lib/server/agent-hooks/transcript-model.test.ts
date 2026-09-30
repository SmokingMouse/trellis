import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findLastAssistantModel, TranscriptModelCache } from "./transcript-model";

const assistant = (model: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "assistant", message: { id: `m-${model}`, model, content: [] }, ...extra });
const user = (text: string) => JSON.stringify({ type: "user", message: { content: text } });

describe("transcript 当前模型", () => {
  test("取最近一条非 sidechain assistant 的 message.model", () => {
    const lines = [
      assistant("claude-sonnet-4"),
      user("hi"),
      assistant("claude-opus-5-5"),
      assistant("claude-haiku", { isSidechain: true }),
      assistant("<synthetic>"),
      user('{"model":"opus"} 用户文本里的 model 不算'),
      "not json",
      "",
    ];
    expect(findLastAssistantModel(lines)).toBe("claude-opus-5-5");
  });

  test("没有 assistant 行 → null", () => {
    expect(findLastAssistantModel([user("hi"), "{bad json"])).toBeNull();
  });

  const dir = mkdtempSync(path.join(tmpdir(), "trellis-transcript-model-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("按文件指纹缓存，追加后重读", () => {
    const file = path.join(dir, "s.jsonl");
    writeFileSync(file, `${assistant("claude-sonnet-4")}\n`);
    let reads = 0;
    const cache = new TranscriptModelCache((f) => {
      reads++;
      return findLastAssistantModel(readFileSync(f, "utf8").split("\n"));
    });
    expect(cache.get(file)).toBe("claude-sonnet-4");
    expect(cache.get(file)).toBe("claude-sonnet-4");
    expect(reads).toBe(1);
    appendFileSync(file, `${assistant("claude-opus-5-5")}\n`);
    expect(cache.get(file)).toBe("claude-opus-5-5");
    expect(reads).toBe(2);
    expect(cache.get(path.join(dir, "missing.jsonl"))).toBeNull();
  });
});
