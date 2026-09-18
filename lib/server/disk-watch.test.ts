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
const { checkDiskAlert } = await import("./disk-watch");

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

const envKeys = ["TRELLIS_DISK_MIN_FREE_PCT", "TRELLIS_DISK_MIN_FREE_BYTES"];
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

test("告警去重：连续低水位只报一次，恢复后再跌破可以再报", async () => {
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

  // 第一轮跌破 → 报一次
  await checkDiskAlert(deps(500, 10));
  expect(sent).toHaveLength(1);
  expect(sent[0].title).toContain("空间不足");
  expect(sent[0].body).toContain("SQLITE_FULL");
  expect(sent[0].body).toContain("2.0%");

  // 连续多轮仍然低 → 不刷屏
  now += 60_000;
  await checkDiskAlert(deps(500, 10));
  now += 5 * 60_000;
  await checkDiskAlert(deps(500, 9));
  expect(sent).toHaveLength(1);

  // 恢复到阈值以上 → 状态清掉（边沿复位）
  now += 60_000;
  await checkDiskAlert(deps(500, 200));
  expect(sent).toHaveLength(1);
  expect(state["disk-low"]).toBeUndefined();

  // 再次跌破 → 可以再报
  now += 60_000;
  await checkDiskAlert(deps(500, 10));
  expect(sent).toHaveLength(2);
});

test("一直不清盘时 6h 冷却后再提醒一次", async () => {
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
  now += 5 * 3600_000;
  await checkDiskAlert(deps());
  expect(sent).toHaveLength(1);
  now += 2 * 3600_000; // 累计 7h > 6h 冷却
  await checkDiskAlert(deps());
  expect(sent).toHaveLength(2);
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
