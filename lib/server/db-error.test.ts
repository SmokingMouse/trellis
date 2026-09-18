import { expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));
const {
  DEFAULT_DB_WAIT_BUDGET_MS,
  DbWriteError,
  classifyDbError,
  dbWaitBudgetMs,
  dbWrite,
  isDbFailure,
  isTransientKind,
  sqliteErrorCode,
  setDbFaultForTests,
} = await import("./db-error");

function sqliteErr(code: string, message: string): Error {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

test("按错误码分类：只有 BUSY/LOCKED 算瞬时，FULL/IOERR 不许重试", () => {
  const cases: [string, string, ReturnType<typeof classifyDbError>][] = [
    ["SQLITE_FULL", "database or disk is full", "full"],
    ["SQLITE_IOERR_WRITE", "disk I/O error", "io"],
    ["SQLITE_BUSY", "database is locked", "busy"],
    ["SQLITE_LOCKED", "database table is locked", "busy"],
    ["SQLITE_READONLY_DBMOVED", "attempt to write a readonly database", "readonly"],
    ["SQLITE_CORRUPT", "database disk image is malformed", "corrupt"],
  ];
  for (const [code, msg, kind] of cases) {
    expect(classifyDbError(sqliteErr(code, msg))).toBe(kind);
  }
  expect(isTransientKind("busy")).toBeTrue();
  for (const k of ["full", "io", "readonly", "corrupt", "unknown"] as const) {
    expect(isTransientKind(k)).toBeFalse();
  }
});

test("没有 .code 时从 message 里捞错误码（驱动换实现也不至于全瞎）", () => {
  const bare = new Error("SQLITE_FULL: database or disk is full");
  expect(sqliteErrorCode(bare)).toBe("SQLITE_FULL");
  expect(classifyDbError(bare)).toBe("full");
  // 连码都没有，只有 sqlite 的原话
  expect(classifyDbError(new Error("database or disk is full"))).toBe("full");
  expect(classifyDbError(new Error("某个业务异常"))).toBe("unknown");
  expect(isDbFailure(new Error("某个业务异常"))).toBeFalse();
  expect(isDbFailure(bare)).toBeTrue();
});

test("SQLITE_FULL 立刻抛，不重试，文案含磁盘与可操作提示", () => {
  let calls = 0;
  const slept: number[] = [];
  expect(() =>
    dbWrite(
      "t",
      () => {
        calls++;
        throw sqliteErr("SQLITE_FULL", "database or disk is full");
      },
      { sleep: (ms) => slept.push(ms) },
    ),
  ).toThrow(DbWriteError);
  expect(calls).toBe(1); // 一次就报，不浪费用户的时间
  expect(slept).toEqual([]);

  try {
    dbWrite("t", () => {
      throw sqliteErr("SQLITE_FULL", "database or disk is full");
    });
  } catch (e) {
    const err = e as InstanceType<typeof DbWriteError>;
    expect(err.kind).toBe("full");
    expect(err.code).toBe("SQLITE_FULL");
    expect(err.userMessage).toContain("磁盘");
    expect(err.userMessage).toContain("数据库写入失败");
    expect(err.userMessage).toContain("重试"); // 可操作提示
    expect(err.userMessage).not.toContain("at "); // 不是 stack
  }
});

test("SQLITE_BUSY 短退避重试；中途成功不报错", () => {
  let calls = 0;
  const slept: number[] = [];
  const out = dbWrite(
    "t",
    () => {
      calls++;
      if (calls < 3) throw sqliteErr("SQLITE_BUSY", "database is locked");
      return "ok";
    },
    { sleep: (ms) => slept.push(ms) },
  );
  expect(out).toBe("ok");
  expect(calls).toBe(3);
  expect(slept).toEqual([20, 60]); // 退避递增且有上限
});

test("SQLITE_BUSY 超过次数上限才报错，文案交代重试过", () => {
  let calls = 0;
  try {
    dbWrite(
      "t",
      () => {
        calls++;
        throw sqliteErr("SQLITE_BUSY", "database is locked");
      },
      { attempts: 4, sleep: () => {} },
    );
    throw new Error("should have thrown");
  } catch (e) {
    const err = e as InstanceType<typeof DbWriteError>;
    expect(err).toBeInstanceOf(DbWriteError);
    expect(err.kind).toBe("busy");
    expect(err.attempts).toBe(4);
    expect(err.userMessage).toContain("重试 4 次");
  }
  expect(calls).toBe(4);
});

// fix-d1：BUSY 的「数据库等待 + 应用重试」共用一个总预算，预算耗尽即按失败返回。
// 这几条是纯逻辑闸；真实持锁的端到端计时在 db-write-failure.test.ts。
test("总等待预算耗尽后不再发起新 attempt（不靠次数上限硬扛）", () => {
  let calls = 0;
  let clock = 0;
  const slept: number[] = [];
  try {
    dbWrite(
      "t",
      () => {
        calls++;
        clock += 900; // 每次 attempt 自己就把预算烧掉一大截（≈ 等满 busy_timeout）
        throw sqliteErr("SQLITE_BUSY", "database is locked");
      },
      {
        attempts: 4,
        budgetMs: 1000,
        now: () => clock,
        sleep: (ms) => {
          slept.push(ms);
          clock += ms;
        },
      },
    );
    throw new Error("should have thrown");
  } catch (e) {
    const err = e as InstanceType<typeof DbWriteError>;
    expect(err).toBeInstanceOf(DbWriteError);
    expect(err.kind).toBe("busy");
    expect(err.attempts).toBe(2); // 次数上限是 4，但预算只够两次
  }
  expect(calls).toBe(2);
  expect(slept).toEqual([20]); // 第一次退避还在预算内，第二次就没预算了
});

test("退避被剩余预算截断，总等待不超过预算", () => {
  let clock = 0;
  const slept: number[] = [];
  expect(() =>
    dbWrite(
      "t",
      () => {
        clock += 40;
        throw sqliteErr("SQLITE_BUSY", "database is locked");
      },
      {
        attempts: 4,
        budgetMs: 150,
        now: () => clock,
        sleep: (ms) => {
          slept.push(ms);
          clock += ms;
        },
      },
    ),
  ).toThrow(DbWriteError);
  // 40 +20 → 40 +50(截断自 60，剩余只有 50) → 40 → 预算耗尽
  expect(slept).toEqual([20, 50]);
  expect(slept.reduce((a, b) => a + b, 0) + 3 * 40).toBeLessThanOrEqual(150 + 40);
});

test("预算可被 TRELLIS_DB_WAIT_BUDGET_MS 覆盖；0 = 不设预算（退回纯次数上限）", () => {
  expect(dbWaitBudgetMs()).toBe(DEFAULT_DB_WAIT_BUDGET_MS);
  expect(DEFAULT_DB_WAIT_BUDGET_MS).toBe(2000);
  process.env.TRELLIS_DB_WAIT_BUDGET_MS = "500";
  expect(dbWaitBudgetMs()).toBe(500);
  process.env.TRELLIS_DB_WAIT_BUDGET_MS = "0";
  expect(dbWaitBudgetMs()).toBe(0);
  process.env.TRELLIS_DB_WAIT_BUDGET_MS = "abc";
  expect(dbWaitBudgetMs()).toBe(DEFAULT_DB_WAIT_BUDGET_MS); // 非法值不至于配瞎
  delete process.env.TRELLIS_DB_WAIT_BUDGET_MS;

  // budgetMs: 0 → 只受次数上限约束，退避表照旧跑满
  let calls = 0;
  const slept: number[] = [];
  expect(() =>
    dbWrite(
      "t",
      () => {
        calls++;
        throw sqliteErr("SQLITE_BUSY", "database is locked");
      },
      { attempts: 4, budgetMs: 0, now: () => 10_000_000, sleep: (ms) => slept.push(ms) },
    ),
  ).toThrow(DbWriteError);
  expect(calls).toBe(4);
  expect(slept).toEqual([20, 60, 180]);
});

test("嵌套 dbWrite 不重复包装，label/code 保持最内层的", () => {
  try {
    dbWrite("outer", () =>
      dbWrite("inner", () => {
        throw sqliteErr("SQLITE_IOERR", "disk I/O error");
      }),
    );
    throw new Error("should have thrown");
  } catch (e) {
    const err = e as InstanceType<typeof DbWriteError>;
    expect(err.label).toBe("inner");
    expect(err.kind).toBe("io");
  }
});

test("故障注入闸：times 用完后自动恢复，清空后不再注入", () => {
  setDbFaultForTests({ code: "SQLITE_FULL", times: 1 });
  expect(() => dbWrite("t", () => 1)).toThrow(DbWriteError);
  expect(dbWrite("t", () => 1)).toBe(1);
  setDbFaultForTests(null);
  expect(dbWrite("t", () => 2)).toBe(2);
});
