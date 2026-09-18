import { afterEach, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));
const {
  DEFAULT_MIN_FREE_BYTES,
  DEFAULT_MIN_FREE_RATIO,
  diskHealthField,
  evaluateWatermark,
  readDiskWatermark,
  trellisDbPath,
} = await import("@/lib/disk-space");
const { checkDiskAlert, DEFAULT_REALERT_MS, realertMs } = await import(
  "./disk-watch"
);

const GiB = 1024 * 1024 * 1024;

/** 假 statfs：按「总容量 / 可用容量」造读数（bsize 固定 4KiB）。 */
function fakeStatfs(totalGiB: number, freeGiB: number) {
  const bsize = 4096;
  return () => ({
    bsize,
    blocks: (totalGiB * GiB) / bsize,
    bavail: (freeGiB * GiB) / bsize,
  });
}

const envKeys = [
  "TRELLIS_DISK_MIN_FREE_PCT",
  "TRELLIS_DISK_MIN_FREE_BYTES",
  "TRELLIS_DISK_REALERT_MS",
];
afterEach(() => {
  for (const k of envKeys) delete process.env[k];
});

test("水位判据：比例或绝对值任一跌破就算低（大盘靠比例、小盘靠字节）", () => {
  // 500G 的盘剩 100G：比例 20% > 5%，字节 100G > 2GiB → 正常
  const healthy = readDiskWatermark("/x/data.db", fakeStatfs(500, 100))!;
  expect(healthy.low).toBeFalse();
  expect(healthy.reason).toBeNull();
  expect(healthy.thresholds).toEqual({
    minFreeRatio: DEFAULT_MIN_FREE_RATIO,
    minFreeBytes: DEFAULT_MIN_FREE_BYTES,
  });

  // 500G 剩 10G：比例 2% < 5% → ratio 命中（BOE 现场 /data00 就是这个形状）
  const byRatio = readDiskWatermark("/x/data.db", fakeStatfs(500, 10))!;
  expect(byRatio.low).toBeTrue();
  expect(byRatio.reason).toBe("ratio");

  // 20G 的小盘剩 1G：比例 5% 刚好不触发，但绝对值 1G < 2GiB → bytes 命中
  const byBytes = readDiskWatermark("/x/data.db", fakeStatfs(20, 1))!;
  expect(byBytes.low).toBeTrue();
  expect(byBytes.reason).toBe("bytes");
});

test("阈值可被 env 覆盖", () => {
  process.env.TRELLIS_DISK_MIN_FREE_PCT = "50";
  process.env.TRELLIS_DISK_MIN_FREE_BYTES = "0";
  const w = readDiskWatermark("/x/data.db", fakeStatfs(500, 100))!;
  expect(w.thresholds.minFreeRatio).toBe(0.5);
  expect(w.low).toBeTrue(); // 20% < 50%
  expect(w.reason).toBe("ratio");
});

test("statfs 失败当成「未知」，不是告警也不是 0", () => {
  const boom = () => {
    throw new Error("ENOENT");
  };
  expect(readDiskWatermark("/x/data.db", boom)).toBeNull();
  const field = diskHealthField("/x/data.db", boom);
  expect(field.freePct).toBeNull();
  expect(field.low).toBeNull();
});

test("健康端点字段：path 是 DB 所在目录，freePct 一位小数", () => {
  const field = diskHealthField("/srv/trellis/data.db", fakeStatfs(500, 10));
  expect(field.path).toBe("/srv/trellis");
  expect(field.freePct).toBe(2);
  expect(field.low).toBeTrue();
  expect(field.totalBytes).toBe(500 * GiB);
  expect(field.freeBytes).toBe(10 * GiB);
  // 默认 target 跟着实际 DB 路径走（水位不能查错分区）
  expect(diskHealthField().path).toBe(
    trellisDbPath().replace(/\/[^/]+$/, ""),
  );
});

// S176 返工（fix-d1）：告警周期语义是**明示**的四条 ——
//   ① 首次跌破立即报一次；② 间隔内不重复；③ 跨过间隔重报一次；
//   ④ 恢复到阈值以上解除锁存，再跌破立即重报（不等间隔）。
// 这四条和 disk-watch.ts 文件头、本单 out/README.md 是同一套说法。
test("告警周期语义：首报 → 间隔内静默 → 跨间隔重报 → 恢复后再跌破立即重报", async () => {
  const sent: { title: string; body: string }[] = [];
  let state: Record<string, number> = {};
  let now = 1_000_000;
  const deps = (totalGiB: number, freeGiB: number) => ({
    dbPath: "/x/data.db",
    statfs: fakeStatfs(totalGiB, freeGiB),
    now: () => now,
    readState: () => ({ ...state }),
    writeState: (s: Record<string, number>) => {
      state = s;
    },
    send: async (e: { title: string; body: string }) => {
      sent.push(e);
    },
  });

  // ① 第一轮跌破 → 立即报一次
  await checkDiskAlert(deps(500, 10));
  expect(sent).toHaveLength(1);
  expect(sent[0].title).toContain("空间不足");
  expect(sent[0].body).toContain("SQLITE_FULL");
  expect(sent[0].body).toContain("2.0%");
  const firstAt = state["disk-low"];
  expect(firstAt).toBe(1_000_000);

  // ② 间隔内连续多轮仍然低 → 不刷屏（scheduler 是 5 分钟一跳，这里跳满 6h 差一步）
  for (let t = 300_000; t < DEFAULT_REALERT_MS; t += 300_000) {
    now = 1_000_000 + t;
    await checkDiskAlert(deps(500, 10));
  }
  expect(sent).toHaveLength(1);
  expect(state["disk-low"]).toBe(firstAt); // 静默期不刷新时间戳

  // ③ 跨过间隔 → 重报一次，并把时间戳推到本次
  now = 1_000_000 + DEFAULT_REALERT_MS;
  await checkDiskAlert(deps(500, 10));
  expect(sent).toHaveLength(2);
  expect(state["disk-low"]).toBe(now);
  // 重报之后又进入新的静默期
  now += 300_000;
  await checkDiskAlert(deps(500, 9));
  expect(sent).toHaveLength(2);

  // ④ 恢复到阈值以上 → 解除锁存
  now += 60_000;
  await checkDiskAlert(deps(500, 200));
  expect(sent).toHaveLength(2);
  expect(state["disk-low"]).toBeUndefined();

  // …再跌破 → 立即重报，不必等满一个间隔
  now += 60_000;
  await checkDiskAlert(deps(500, 10));
  expect(sent).toHaveLength(3);
});

test("重报间隔可被 TRELLIS_DISK_REALERT_MS 覆盖；0 = 只报一次直到恢复", async () => {
  expect(realertMs()).toBe(DEFAULT_REALERT_MS);
  process.env.TRELLIS_DISK_REALERT_MS = "60000";
  expect(realertMs()).toBe(60_000);

  const sent: unknown[] = [];
  let state: Record<string, number> = {};
  let now = 1_000_000;
  const deps = () => ({
    dbPath: "/x/data.db",
    statfs: fakeStatfs(500, 10),
    now: () => now,
    readState: () => ({ ...state }),
    writeState: (s: Record<string, number>) => {
      state = s;
    },
    send: async (e: unknown) => {
      sent.push(e);
    },
  });
  await checkDiskAlert(deps());
  now += 30_000;
  await checkDiskAlert(deps());
  expect(sent).toHaveLength(1); // 还没满 60s
  now += 30_000;
  await checkDiskAlert(deps());
  expect(sent).toHaveLength(2); // 满了 → 重报

  // 0 = 关掉周期重报：一直低就一直沉默（老契约里「只报一次」的那条语义）
  process.env.TRELLIS_DISK_REALERT_MS = "0";
  state = {};
  sent.length = 0;
  await checkDiskAlert(deps());
  expect(sent).toHaveLength(1);
  for (let i = 0; i < 100; i++) {
    now += 6 * 3600_000;
    await checkDiskAlert(deps());
  }
  expect(sent).toHaveLength(1);

  // 非法值回落到默认，不至于把监控配瞎
  process.env.TRELLIS_DISK_REALERT_MS = "abc";
  expect(realertMs()).toBe(DEFAULT_REALERT_MS);
});

test("水位读不出来时不发告警，也不写状态", async () => {
  let wrote = false;
  const out = await checkDiskAlert({
    dbPath: "/x/data.db",
    statfs: () => {
      throw new Error("statfs unsupported");
    },
    readState: () => ({}),
    writeState: () => {
      wrote = true;
    },
    send: async () => {
      throw new Error("不该发");
    },
  });
  expect(out).toBeNull();
  expect(wrote).toBeFalse();
});

test("真机 statfs 能跑通（阈值判定不靠假数据也成立）", () => {
  const real = readDiskWatermark();
  expect(real).not.toBeNull();
  expect(real!.totalBytes).toBeGreaterThan(0);
  expect(evaluateWatermark(real!).low).toBe(real!.low);
});
