// 「解析大 transcript 期间事件循环不被钉死」的回归。
//
// 这是根因 B 的判据本身：devbox 上一个 185MB 的 codex rollout 被持续写入，
// 每次 watcher 去抖后的全量解析都把事件循环占满，尖峰时 /login 要 1–3.3s。
// 这里用 40MB 的合成文件（跑得完、量级足够体现），断言异步分片解析期间
// **单次事件循环阻塞 < 100ms**。
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeSyntheticClaudeJsonl } from "../../scripts/bench-cli-parse";
import {
  parseCliTranscript,
  parseCliTranscriptAsync,
  resetCliTranscriptCache,
} from "./cli-transcript";

const file = path.join(
  os.tmpdir(),
  `trellis-eventloop-${process.pid}-${Date.now()}.jsonl`,
);
afterAll(() => fs.rmSync(file, { force: true }));

/** 1ms 定时器打点：相邻两次回调的间隔就是那一刻事件循环被占用的时长。 */
function startLagProbe() {
  let max = 0;
  let last = performance.now();
  let stopped = false;
  const tick = () => {
    const now = performance.now();
    const lag = now - last - 1;
    if (lag > max) max = lag;
    last = now;
    if (!stopped) setTimeout(tick, 1);
  };
  setTimeout(tick, 1);
  return () => {
    stopped = true;
    return max;
  };
}

test(
  "解析 ~40MB transcript 期间，事件循环单次阻塞 < 100ms",
  async () => {
    // 每 turn ≈ 17KB。
    writeSyntheticClaudeJsonl(file, Math.round((40 * 1024 * 1024) / 17000));
    const sizeMb = fs.statSync(file).size / 1024 / 1024;
    expect(sizeMb).toBeGreaterThan(30);

    // 改后：异步分片解析。
    resetCliTranscriptCache();
    let stop = startLagProbe();
    await Bun.sleep(20);
    const asyncStart = performance.now();
    const asyncParsed = await parseCliTranscriptAsync("claude", file);
    const asyncElapsed = performance.now() - asyncStart;
    await Bun.sleep(20);
    const asyncMaxLag = stop();

    // 改前基线：同步全量解析（老路径的行为），用来说明上面那条不是白测。
    resetCliTranscriptCache();
    stop = startLagProbe();
    await Bun.sleep(20);
    const syncStart = performance.now();
    const syncParsed = parseCliTranscript("claude", file);
    const syncElapsed = performance.now() - syncStart;
    await Bun.sleep(20);
    const syncMaxLag = stop();

    console.log(
      `[eventloop] ${sizeMb.toFixed(1)}MB  async: ${asyncElapsed.toFixed(0)}ms / maxLag ${asyncMaxLag.toFixed(1)}ms` +
        `   sync: ${syncElapsed.toFixed(0)}ms / maxLag ${syncMaxLag.toFixed(1)}ms`,
    );

    // 硬判据。
    expect(asyncMaxLag).toBeLessThan(100);
    // 结果等价（分片不改变语义）。
    expect(asyncParsed!.turns.length).toBe(syncParsed!.turns.length);
    expect(asyncParsed).toEqual(syncParsed);
    // 对照：同步路径真的把事件循环钉住了才说明分片有意义。机器太快
    // （同步全量都不到 60ms）时这条不成立，跳过而不是制造假红。
    if (syncMaxLag >= 60) {
      expect(asyncMaxLag).toBeLessThan(syncMaxLag);
    }
  },
  120_000,
);

test(
  "持续追加期间，每次增量解析的事件循环阻塞都 < 100ms",
  async () => {
    // 接着上一条的文件继续追加（模拟存活进程每 10s +60KB 的写入节奏）。
    let cursor = { nextUuid: 0, lastUuid: null as string | null };
    if (!fs.existsSync(file)) {
      writeSyntheticClaudeJsonl(file, Math.round((40 * 1024 * 1024) / 17000));
    }
    // 复位缓存，先做一次冷解析建立基线偏移。
    resetCliTranscriptCache();
    const cold = await parseCliTranscriptAsync("claude", file);
    expect(cold).not.toBeNull();
    // 追加游标接在文件末尾之后，uuid 空间与已有内容不重叠。
    cursor = { nextUuid: 10_000_000, lastUuid: cold!.lastUuid };

    let worst = 0;
    for (let round = 0; round < 3; round++) {
      cursor = writeSyntheticClaudeJsonl(
        file,
        4, // ≈ 68KB
        1_000_000 + round * 4,
        cursor.nextUuid,
        cursor.lastUuid,
      );
      const stop = startLagProbe();
      await Bun.sleep(20);
      const parsed = await parseCliTranscriptAsync("claude", file);
      await Bun.sleep(20);
      const lag = stop();
      if (lag > worst) worst = lag;
      expect(parsed!.turns.length).toBe(cold!.turns.length + (round + 1) * 4);
    }
    console.log(`[eventloop] 增量追加三轮最大阻塞 ${worst.toFixed(1)}ms`);
    expect(worst).toBeLessThan(100);
  },
  120_000,
);
