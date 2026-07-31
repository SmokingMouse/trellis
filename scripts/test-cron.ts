// lib/cron.ts 的单测。跑：bun scripts/test-cron.ts
//
// cron 是整个调度层唯一「纯逻辑、错了很难从现象看出来」的部分 —— 一个 dom/dow
// 的 OR 语义写反，症状是「某个任务偶尔多跑一次」，几周后才会被注意到。所以它
// 必须有覆盖到边界的测试，而不是靠跑一遍看着像对的。

import { parseCron, cronMatches, nextFireAfter, describeCron } from "../lib/cron";

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`  ✗ ${label}`);
  }
}

function at(s: string): Date {
  // "2026-07-31 09:00" —— 本地时区，与 cronMatches 用的 getHours 一致。
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s)!;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0);
}

function matches(expr: string, when: string): boolean {
  const f = parseCron(expr);
  if (!f) throw new Error(`parse failed: ${expr}`);
  return cronMatches(f, at(when));
}

console.log("── parse ──");
ok(parseCron("0 9 * * *") !== null, "标准五字段");
ok(parseCron("*/15 * * * *") !== null, "步长");
ok(parseCron("0 9 * * 1-5") !== null, "范围");
ok(parseCron("0 9,18 * * *") !== null, "列表");
ok(parseCron("0 9 * *") === null, "四字段应拒绝");
ok(parseCron("0 9 * * * *") === null, "六字段应拒绝");
ok(parseCron("60 9 * * *") === null, "分钟越界应拒绝");
ok(parseCron("0 24 * * *") === null, "小时越界应拒绝");
ok(parseCron("0 9 0 * *") === null, "日 0 应拒绝（dom 从 1 起）");
ok(parseCron("0 9 * 13 *") === null, "月 13 应拒绝");
ok(parseCron("0 9 * * 8") === null, "周 8 应拒绝");
ok(parseCron("") === null, "空串应拒绝");
ok(parseCron("a b c d e") === null, "非数字应拒绝");
ok(parseCron("0 9 * * 7") !== null, "周 7 = 周日，应接受");
ok(parseCron("5-3 9 * * *") === null, "倒序范围应拒绝");
ok(parseCron("0 9 * * */0") === null, "步长 0 应拒绝");

console.log("── match：每天 09:00 ──");
ok(matches("0 9 * * *", "2026-07-31 09:00"), "正点命中");
ok(!matches("0 9 * * *", "2026-07-31 09:01"), "差一分钟不中");
ok(!matches("0 9 * * *", "2026-07-31 08:00"), "差一小时不中");
ok(matches("0 9 * * *", "2026-12-31 09:00"), "跨月跨年照常");

console.log("── match：工作日 ──");
// 2026-07-31 是周五，08-01 周六，08-03 周一
ok(matches("0 9 * * 1-5", "2026-07-31 09:00"), "周五命中");
ok(!matches("0 9 * * 1-5", "2026-08-01 09:00"), "周六不中");
ok(!matches("0 9 * * 1-5", "2026-08-02 09:00"), "周日不中");
ok(matches("0 9 * * 1-5", "2026-08-03 09:00"), "周一命中");
ok(matches("0 9 * * 0", "2026-08-02 09:00"), "dow=0 命中周日");
ok(matches("0 9 * * 7", "2026-08-02 09:00"), "dow=7 也命中周日");

console.log("── match：步长 ──");
ok(matches("*/15 * * * *", "2026-07-31 09:00"), "*/15 命中 :00");
ok(matches("*/15 * * * *", "2026-07-31 09:15"), "*/15 命中 :15");
ok(!matches("*/15 * * * *", "2026-07-31 09:16"), "*/15 不中 :16");
ok(matches("*/15 * * * *", "2026-07-31 09:45"), "*/15 命中 :45");

console.log("── match：dom / dow 的 OR 怪癖（最容易写错的一条）──");
// 标准 cron：dom 与 dow 都受限时是 OR。2026-08-01 是周六。
ok(matches("0 0 1 * 1", "2026-08-01 00:00"), "1 号（非周一）应命中 —— OR 语义");
ok(matches("0 0 1 * 1", "2026-08-03 00:00"), "周一（非 1 号）应命中 —— OR 语义");
ok(!matches("0 0 1 * 1", "2026-08-04 00:00"), "既非 1 号也非周一，不中");
// 只有 dom 受限 → 纯 AND（dow 是 *，不参与）
ok(matches("0 0 1 * *", "2026-08-01 00:00"), "只限 dom：1 号命中");
ok(!matches("0 0 1 * *", "2026-08-02 00:00"), "只限 dom：2 号不中");

console.log("── match：月末 / 闰年 ──");
ok(matches("0 0 31 * *", "2026-07-31 00:00"), "31 号存在的月份命中");
ok(matches("0 0 29 2 *", "2028-02-29 00:00"), "闰年 2/29 命中");
ok(!matches("0 0 30 2 *", "2028-02-29 00:00"), "2/30 永不存在");

console.log("── nextFireAfter ──");
{
  const f = parseCron("0 9 * * *")!;
  const next = nextFireAfter(f, at("2026-07-31 08:00"));
  ok(next === at("2026-07-31 09:00").getTime(), "同日下一个 9 点");
  const next2 = nextFireAfter(f, at("2026-07-31 09:00"));
  ok(next2 === at("2026-08-01 09:00").getTime(), "正点调用应给出**下一天**（不是当前这分钟）");
  const never = nextFireAfter(parseCron("0 0 30 2 *")!, at("2026-07-31 00:00"));
  ok(never === null, "2/30 永不触发 → null");
}

console.log("── describeCron ──");
ok(describeCron("0 9 * * *") === "每天 09:00", "每天");
ok(describeCron("0 9 * * 1-5") === "每个工作日 09:00", "工作日");
ok(describeCron("*/30 * * * *") === "每 30 分钟", "每 N 分钟");
ok(describeCron("0 9 1 * *") === "每月 1 号 09:00", "每月");
ok(describeCron("0 9 * * 1") === "每周一 09:00", "每周");
ok(describeCron("bogus") === "表达式无效", "无效串");
ok(describeCron("7 3 5 6 2") === "7 3 5 6 2", "认不出的形状回原串");

console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
