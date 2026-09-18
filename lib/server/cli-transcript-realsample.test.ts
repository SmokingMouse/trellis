// 真实 codex rollout 样本上的增量/短路/截断回归。
//
// 合成 jsonl（cli-transcript-incremental.test.ts）覆盖的是**我写得出来**的形状；
// 这一份覆盖的是真会话里实际长出来的形状 —— compacted 事件、token_usage_record、
// world_state、turn_context 改 turn_id、以及 10MB 边界上那条天然被截断的半行。
//
// 样本是运维从一个 197MB 的存活 rollout 上切下来的**真实工作会话原文**：
//   /tmp/rollout-sample-head-10m.jsonl  10485760B / 3076 完整行 + 2132B 尾部残片
//   /tmp/rollout-sample-tail-10m.jsonl  10485760B / 首行即半行残片 + 2615 完整行
// 它们**不入库**（不复制进 repo、不进报告正文），只在本机跑。所以：样本不在时
// 这些用例整体跳过，`bun test` 在干净机器上照样全绿。路径可用环境变量覆盖。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCodexSessionJsonl } from "./codex-import";
import {
  cliTranscriptCacheStats,
  parseCliTranscript,
  parseCliTranscriptAsync,
  resetCliTranscriptCache,
} from "./cli-transcript";

const HEAD_SAMPLE =
  process.env.TRELLIS_ROLLOUT_SAMPLE_HEAD ?? "/tmp/rollout-sample-head-10m.jsonl";
const TAIL_SAMPLE =
  process.env.TRELLIS_ROLLOUT_SAMPLE_TAIL ?? "/tmp/rollout-sample-tail-10m.jsonl";

const samplesPresent =
  fs.existsSync(HEAD_SAMPLE) && fs.existsSync(TAIL_SAMPLE);

if (!samplesPresent) {
  console.log(
    `[realsample] 跳过：未找到真实 rollout 样本（${HEAD_SAMPLE} / ${TAIL_SAMPLE}）。` +
      `样本是本机文件、不入 repo；需要时向运维索取或用 TRELLIS_ROLLOUT_SAMPLE_HEAD/TAIL 指路。`,
  );
}

const suite = samplesPresent ? describe : describe.skip;

// 派生文件写在 tmp、用完即删。样本本体只读，绝不改动。
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-realsample-"));
afterAll(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

/** 不大于 limit 的最后一个换行符下标；没有则 -1。 */
function lastNewlineAtMost(buf: Buffer, limit: number): number {
  return buf.lastIndexOf(0x0a, Math.min(limit, buf.length - 1));
}

function derived(name: string): string {
  return path.join(tempRoot, `${name}.jsonl`);
}

suite("真实 codex rollout 样本", () => {
  beforeEach(() => resetCliTranscriptCache());

  // ── ① 就地零拷贝：缓存入口与裸全量解析结果相同 ─────────────────────────────
  test("head 样本就地解析：带缓存入口 === 裸全量解析", () => {
    const full = parseCodexSessionJsonl(HEAD_SAMPLE);
    const viaCache = parseCliTranscript("codex", HEAD_SAMPLE);
    expect(viaCache).toEqual(full);
    expect(full!.turns.length).toBeGreaterThan(0);
    // lastUuid 是 codex 的追加游标 `字节数:完整 entry 数`。尾部那 2132B 残片
    // 解不出来 → 不计数，两边必须都这么算。
    const size = fs.statSync(HEAD_SAMPLE).size;
    expect(full!.lastUuid).toBe(`${size}:3076`);
    expect(size).toBe(10_485_760);
  });

  test("head 样本：异步分片解析结果也相同", async () => {
    const full = parseCodexSessionJsonl(HEAD_SAMPLE);
    expect(await parseCliTranscriptAsync("codex", HEAD_SAMPLE)).toEqual(full);
  });

  test("tail 样本（无 session_meta、首行即残片）两条路都判 null", () => {
    // 这个片段单独拿出来不是一个可解析的会话 —— 关键是缓存入口不能因为
    // "读到了 10MB 内容" 就编造出半个会话来。
    expect(parseCodexSessionJsonl(TAIL_SAMPLE)).toBeNull();
    expect(parseCliTranscript("codex", TAIL_SAMPLE)).toBeNull();
  });

  // ── ② 等价性：分 3 次增量（其中一次切在半行处）=== 一次全量 ────────────────
  test("head 样本分三次增量（第二段切在半行处）与全量解析 turns 完全相同", () => {
    const bytes = fs.readFileSync(HEAD_SAMPLE);
    const file = derived("equiv-3step");

    // 第一刀切在完整行边界上。
    const cutA = lastNewlineAtMost(bytes, Math.floor(bytes.length / 3)) + 1;
    expect(cutA).toBeGreaterThan(0);
    // 第二刀**故意切在一行中间**：从 2/3 处的行首再往前挪半行。
    const lineStart = lastNewlineAtMost(bytes, Math.floor((bytes.length * 2) / 3)) + 1;
    const lineEnd = bytes.indexOf(0x0a, lineStart);
    expect(lineEnd).toBeGreaterThan(lineStart + 1);
    const cutB = lineStart + Math.floor((lineEnd - lineStart) / 2);
    // 确认这一刀之后确实挂着一截没写完的行。
    expect(cutB).toBeGreaterThan(lastNewlineAtMost(bytes, cutB - 1) + 1);
    expect(cutB).toBeLessThan(lineEnd);

    // 第一段：完整行。
    fs.writeFileSync(file, bytes.subarray(0, cutA));
    const step1 = parseCliTranscript("codex", file);
    expect(step1).toEqual(parseCodexSessionJsonl(file));

    // 第二段：结尾挂半行。半行必须留到下次，不能被当成损坏行"消化掉"。
    fs.appendFileSync(file, bytes.subarray(cutA, cutB));
    const step2 = parseCliTranscript("codex", file);
    expect(step2).toEqual(parseCodexSessionJsonl(file));

    // 第三段：补齐半行 + 剩余全部（含样本天然的 2132B 尾部残片）。
    fs.appendFileSync(file, bytes.subarray(cutB));
    expect(fs.statSync(file).size).toBe(bytes.length);
    const incremental = parseCliTranscript("codex", file);

    // 与"从没见过这个文件、一次性解析"三方比对。
    const oneShotRaw = parseCodexSessionJsonl(file);
    resetCliTranscriptCache();
    const oneShotCached = parseCliTranscript("codex", file);

    expect(incremental).toEqual(oneShotRaw);
    expect(incremental).toEqual(oneShotCached);
    // turns 完全相同（深比较已覆盖，这条是失败时的可读信号）。
    expect(incremental!.turns).toEqual(oneShotRaw!.turns);
    expect(incremental!.turns.length).toBe(
      parseCodexSessionJsonl(HEAD_SAMPLE)!.turns.length,
    );
    expect(incremental!.lastUuid).toBe(`${bytes.length}:3076`);
  });

  test("head 样本分三次增量：异步分片路径同样等价", async () => {
    const bytes = fs.readFileSync(HEAD_SAMPLE);
    const file = derived("equiv-3step-async");
    const cutA = lastNewlineAtMost(bytes, Math.floor(bytes.length / 3)) + 1;
    const lineStart = lastNewlineAtMost(bytes, Math.floor((bytes.length * 2) / 3)) + 1;
    const lineEnd = bytes.indexOf(0x0a, lineStart);
    const cutB = lineStart + Math.floor((lineEnd - lineStart) / 2);

    fs.writeFileSync(file, bytes.subarray(0, cutA));
    expect(await parseCliTranscriptAsync("codex", file)).toEqual(
      parseCodexSessionJsonl(file),
    );
    fs.appendFileSync(file, bytes.subarray(cutA, cutB));
    expect(await parseCliTranscriptAsync("codex", file)).toEqual(
      parseCodexSessionJsonl(file),
    );
    fs.appendFileSync(file, bytes.subarray(cutB));
    expect(await parseCliTranscriptAsync("codex", file)).toEqual(
      parseCodexSessionJsonl(file),
    );
  });

  // ── ③ 半行残片：直接用 tail 样本的首行 ─────────────────────────────────────
  test("tail 样本首行残片：留到下次、不被当成损坏，也不吃掉后面的行", () => {
    const head = fs.readFileSync(HEAD_SAMPLE);
    const tail = fs.readFileSync(TAIL_SAMPLE);

    // tail 样本的首行就是从一条真实长行中间切出来的残片（不含换行）。
    const fragmentEnd = tail.indexOf(0x0a);
    expect(fragmentEnd).toBeGreaterThan(0);
    const fragment = tail.subarray(0, fragmentEnd);
    // 它确实不是合法 JSON —— 这正是"半行"的定义。
    expect(() => JSON.parse(fragment.toString("utf8"))).toThrow();

    // 基线：head 的前 1/4（完整行）。
    const baseEnd = lastNewlineAtMost(head, Math.floor(head.length / 4)) + 1;
    const file = derived("residue-tailfirstline");
    fs.writeFileSync(file, head.subarray(0, baseEnd));
    const base = parseCliTranscript("codex", file);
    expect(base).toEqual(parseCodexSessionJsonl(file));

    // 追加残片（不带换行）。这一步的判据：结果与全量解析一致，且**与残片出现
    // 之前完全相同** —— 残片既没被当成一条损坏行吞掉，也没污染已有 turn。
    fs.appendFileSync(file, fragment);
    const withResidue = parseCliTranscript("codex", file);
    expect(withResidue).toEqual(parseCodexSessionJsonl(file));
    expect(withResidue!.turns).toEqual(base!.turns);

    // 再给残片补上换行 + head 的下一段完整行。残片这时才成为一条"已提交但解不
    // 出来"的行（与全量解析里的待遇一模一样：跳过），它后面的行必须毫发无损。
    const nextEnd = lastNewlineAtMost(head, Math.floor(head.length / 2)) + 1;
    fs.appendFileSync(
      file,
      Buffer.concat([Buffer.from("\n"), head.subarray(baseEnd, nextEnd)]),
    );
    const after = parseCliTranscript("codex", file);
    expect(after).toEqual(parseCodexSessionJsonl(file));

    // 对照组：同样的内容但**没有**那条残片行 —— turns 必须一字不差。
    const clean = derived("residue-control");
    fs.writeFileSync(clean, head.subarray(0, nextEnd));
    expect(after!.turns).toEqual(parseCodexSessionJsonl(clean)!.turns);
  });

  // ── ④ 只读增量、短路、截断（真样本尺度）───────────────────────────────────
  test("head 样本追加时只读新增字节", () => {
    const bytes = fs.readFileSync(HEAD_SAMPLE);
    const cut = lastNewlineAtMost(bytes, Math.floor(bytes.length / 2)) + 1;
    const file = derived("append-only");
    fs.writeFileSync(file, bytes.subarray(0, cut));
    parseCliTranscript("codex", file);

    const appended = bytes.subarray(cut);
    fs.appendFileSync(file, appended);
    const before = cliTranscriptCacheStats();
    const parsed = parseCliTranscript("codex", file);
    const after = cliTranscriptCacheStats();

    expect(after.incrementalReads - before.incrementalReads).toBe(1);
    expect(after.fullReads - before.fullReads).toBe(0);
    expect(after.bytesRead - before.bytesRead).toBe(appended.length);
    expect(parsed).toEqual(parseCodexSessionJsonl(HEAD_SAMPLE));
  });

  test("head 样本未变化时再次解析零读取", () => {
    const first = parseCliTranscript("codex", HEAD_SAMPLE);
    const realOpenSync = fs.openSync;
    const realReadFileSync = fs.readFileSync;
    let opens = 0;
    let readFiles = 0;
    const target = fs as unknown as Record<string, unknown>;
    target.openSync = (...args: Parameters<typeof fs.openSync>) => {
      opens++;
      return realOpenSync(...args);
    };
    target.readFileSync = (...args: Parameters<typeof fs.readFileSync>) => {
      readFiles++;
      return realReadFileSync(...args);
    };
    let second: ReturnType<typeof parseCliTranscript>;
    let bytesDelta = -1;
    try {
      const before = cliTranscriptCacheStats();
      second = parseCliTranscript("codex", HEAD_SAMPLE);
      bytesDelta = cliTranscriptCacheStats().bytesRead - before.bytesRead;
    } finally {
      target.openSync = realOpenSync;
      target.readFileSync = realReadFileSync;
    }
    expect(opens).toBe(0);
    expect(readFiles).toBe(0);
    expect(bytesDelta).toBe(0);
    expect(second).toEqual(first);
  });

  test("head 样本被截短后回退全量，不残留旧 turn", () => {
    const bytes = fs.readFileSync(HEAD_SAMPLE);
    const file = derived("truncate");
    fs.writeFileSync(file, bytes);
    const whole = parseCliTranscript("codex", file);
    expect(whole!.turns.length).toBeGreaterThan(1);

    // 截到 1/5，且切在完整行边界上。
    const shortEnd = lastNewlineAtMost(bytes, Math.floor(bytes.length / 5)) + 1;
    fs.writeFileSync(file, bytes.subarray(0, shortEnd));
    const before = cliTranscriptCacheStats();
    const parsed = parseCliTranscript("codex", file);
    const after = cliTranscriptCacheStats();

    expect(after.fullReads - before.fullReads).toBe(1);
    expect(after.evictions - before.evictions).toBe(1);
    expect(parsed).toEqual(parseCodexSessionJsonl(file));
    expect(parsed!.turns.length).toBeLessThanOrEqual(whole!.turns.length);
    // 截断后残留旧 turn 是这条用例真正要抓的 bug。
    const keptIds = new Set(parsed!.turns.map((t) => t.id));
    const liveIds = new Set(parseCodexSessionJsonl(file)!.turns.map((t) => t.id));
    expect([...keptIds]).toEqual([...liveIds]);
  });
});
