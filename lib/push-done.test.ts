import { describe, expect, test } from "bun:test";
import { FakeTimers } from "./__fixtures__/fake-timers";
import { DoneScheduler, doneDelayFromEnv, PUSH_DONE_DELAY_MS, type DoneProbe } from "./push-done";

function setup(initial: DoneProbe = { status: "done" }, holdMs = 10 * 60_000) {
  const clock = new FakeTimers();
  const delivered: string[] = [];
  let probe = initial;
  const s = new DoneScheduler<{ n: number }>({
    timers: clock,
    delayMs: 60_000,
    holdMs,
    probe: () => probe,
    deliver: (key, info) => delivered.push(`${key}#${info.n}`),
  });
  return { clock, delivered, s, setProbe: (p: DoneProbe) => { probe = p; } };
}

describe("DoneScheduler", () => {
  test("结束后满 60s 才推；同一 key 再次结束只认最新一次", () => {
    const { clock, delivered, s } = setup();
    s.ended("a", { n: 1 }, "s1");
    clock.advance(30_000);
    s.ended("a", { n: 2 }, "s1");
    clock.advance(59_999 - 30_000);
    expect(delivered).toEqual([]);
    clock.advance(30_001);
    expect(delivered).toEqual(["a#2"]);
    expect(s.has("a")).toBe(false);
    clock.advance(10 * 60_000);
    expect(delivered).toEqual(["a#2"]);
  });

  test("延迟内又开始干活：这次作废；之后真正结束再计时", () => {
    const { clock, delivered, s } = setup();
    s.ended("a", { n: 1 }, null);
    clock.advance(20_000);
    s.working("a");
    clock.advance(120_000);
    expect(delivered).toEqual([]);
    expect(clock.pending).toBe(0);
    s.ended("a", { n: 2 }, null);
    clock.advance(60_000);
    expect(delivered).toEqual(["a#2"]);
  });

  test("到点现查：又在干活 → stale；会话没了 / 已读 → 不推", () => {
    const { clock, delivered, s, setProbe } = setup({ status: "working" });
    s.ended("a", { n: 1 }, null);
    clock.advance(60_000);
    expect(delivered).toEqual([]);
    setProbe({ status: "gone" });
    s.ended("b", { n: 1 }, null);
    setProbe({ status: "done", seen: true });
    s.ended("c", { n: 1 }, null);
    clock.advance(60_000);
    expect(delivered).toEqual([]);
  });

  test("延迟窗口里在前台看过 → 不推；只影响同会话、只影响已在等的那次", () => {
    const { clock, delivered, s } = setup();
    s.seen("s1"); // 结束前的心跳不算
    s.ended("a", { n: 1 }, "s1");
    s.ended("b", { n: 1 }, "s2");
    clock.advance(10_000);
    s.seen("s1");
    clock.advance(60_000);
    expect(delivered).toEqual(["b#1"]);
    // 看过之后的下一轮照常判
    s.ended("a", { n: 2 }, "s1");
    clock.advance(60_000);
    expect(delivered).toEqual(["b#1", "a#2"]);
  });

  test("结束时后台任务还在跑：挂起；回报唤起的那一轮结束时才推，只推一次", () => {
    const { clock, delivered, s, setProbe } = setup({ status: "done", background: true });
    s.ended("a", { n: 1 }, null);
    clock.advance(60_000);
    expect(delivered).toEqual([]);
    expect(s.has("a")).toBe(true);
    // 回报到了，唤起一轮：干活中挂起状态保留
    s.working("a");
    expect(s.has("a")).toBe(true);
    setProbe({ status: "done", background: false, wokeByTask: true });
    s.ended("a", { n: 2 }, null);
    clock.advance(60_000);
    expect(delivered).toEqual(["a#2"]);
    expect(s.has("a")).toBe(false);
  });

  test("回报唤起、但之前没挂起（例如上一轮已推过 / 重启后）：不推", () => {
    const { clock, delivered, s } = setup({ status: "done", wokeByTask: true });
    s.ended("a", { n: 1 }, null);
    clock.advance(60_000);
    expect(delivered).toEqual([]);
  });

  test("挂起超过 holdMs：放弃", () => {
    const { clock, delivered, s } = setup({ status: "done", background: true }, 5 * 60_000);
    s.ended("a", { n: 1 }, null);
    clock.advance(60_000);
    // 挂起期间又结束了一轮，后台仍未完：还在 holdMs 内 → 继续挂
    s.ended("a", { n: 2 }, null);
    clock.advance(60_000);
    expect(s.has("a")).toBe(true);
    clock.advance(5 * 60_000);
    s.ended("a", { n: 3 }, null);
    clock.advance(60_000);
    expect(delivered).toEqual([]);
    expect(s.has("a")).toBe(false);
  });

  test("cancel 连挂起一起清；探测抛错按不推处理", () => {
    const { clock, delivered, s } = setup({ status: "done", background: true });
    s.ended("a", { n: 1 }, null);
    clock.advance(60_000);
    s.cancel("a");
    expect(s.has("a")).toBe(false);
    const broken = new DoneScheduler<null>({
      timers: clock,
      delayMs: 1,
      probe: () => { throw new Error("boom"); },
      deliver: () => delivered.push("x"),
    });
    broken.ended("k", null, null);
    clock.advance(1);
    expect(delivered).toEqual([]);
  });

  test("延迟可经环境变量配置，非法值回落 60s", () => {
    expect(doneDelayFromEnv({})).toBe(PUSH_DONE_DELAY_MS);
    expect(doneDelayFromEnv({ TRELLIS_PUSH_DONE_DELAY_MS: "5000" })).toBe(5000);
    expect(doneDelayFromEnv({ TRELLIS_PUSH_DONE_DELAY_MS: "abc" })).toBe(PUSH_DONE_DELAY_MS);
    expect(doneDelayFromEnv({ TRELLIS_PUSH_DONE_DELAY_MS: "-1" })).toBe(PUSH_DONE_DELAY_MS);
  });
});
