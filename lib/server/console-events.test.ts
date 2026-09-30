import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));
const { ConsoleHub } = await import("./console-events");
type Change = import("./console-events").ConsoleChange;

function harness(initial = { fleet: "f1", hooks: "h1" }) {
  const etags = { ...initial };
  const timers: { fn: () => void; ms: number }[] = [];
  const counts = { fleet: 0, hooks: 0 };
  const hub = new ConsoleHub({
    fleetEtag: () => { counts.fleet++; return etags.fleet; },
    hooksEtag: () => { counts.hooks++; return etags.hooks; },
    coalesceMs: 100,
    schedule: (fn, ms) => { timers.push({ fn, ms }); },
  });
  const seen: Change[] = [];
  const runTimers = () => { for (const t of timers.splice(0)) t.fn(); };
  return { hub, etags, timers, counts, seen, runTimers };
}

describe("ConsoleHub 合并节流", () => {
  test("无订阅者：通知零成本，不排定时器、不算 ETag", () => {
    const h = harness();
    h.hub.notify("hook");
    expect(h.timers).toHaveLength(0);
    expect(h.counts.fleet + h.counts.hooks).toBe(0);
  });

  test("窗口内多次触发只排一个定时器、只广播一次，kinds 去重合并", () => {
    const h = harness();
    h.hub.subscribe(c => h.seen.push(c));
    h.etags.fleet = "f2";
    h.hub.notify("herdr");
    h.hub.notify("hook");
    h.hub.notify("herdr");
    h.hub.notify("transcript");
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].ms).toBe(100);
    h.runTimers();
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]).toEqual({ type: "changed", fleetEtag: "f2", hooksEtag: "h1", kinds: ["herdr", "hook", "transcript"] });
  });

  test("ETag 都没变就不广播（Herdr 事件不影响 fleet 投影时不打扰客户端）", () => {
    const h = harness();
    h.hub.subscribe(c => h.seen.push(c));
    h.hub.notify("herdr");
    h.runTimers();
    expect(h.seen).toHaveLength(1); // 首次无基线，广播
    h.hub.notify("herdr");
    h.runTimers();
    expect(h.seen).toHaveLength(1);
    h.etags.hooks = "h2";
    h.hub.notify("hook");
    h.runTimers();
    expect(h.seen.map(c => c.hooksEtag)).toEqual(["h1", "h2"]);
  });

  test("只重算可能变了的半边：transcript / herdr 不扫 hook 表，hook 不算 fleet", () => {
    const h = harness();
    h.hub.subscribe(c => h.seen.push(c));
    h.hub.notify("herdr");
    h.runTimers(); // 基线：两边都算
    expect(h.counts).toEqual({ fleet: 1, hooks: 1 });
    h.etags.fleet = "f2";
    h.hub.notify("transcript");
    h.runTimers();
    expect(h.counts).toEqual({ fleet: 2, hooks: 1 });
    expect(h.seen.at(-1)).toMatchObject({ fleetEtag: "f2", hooksEtag: "h1" });
    h.etags.hooks = "h2";
    h.hub.notify("hook");
    h.runTimers();
    expect(h.counts).toEqual({ fleet: 2, hooks: 2 });
    expect(h.seen.at(-1)).toMatchObject({ fleetEtag: "f2", hooksEtag: "h2", kinds: ["hook"] });
  });

  test("窗口结束后的新触发开新窗口", () => {
    const h = harness();
    h.hub.subscribe(c => h.seen.push(c));
    h.hub.notify("herdr");
    h.runTimers();
    h.etags.fleet = "f3";
    h.hub.notify("herdr");
    expect(h.timers).toHaveLength(1);
    h.runTimers();
    expect(h.seen.at(-1)?.fleetEtag).toBe("f3");
  });

  test("ETag 计算抛错 → null（客户端会保守地拉一次），不炸广播", () => {
    const h = harness();
    const hub = new ConsoleHub({
      fleetEtag: () => { throw new Error("boom"); },
      hooksEtag: () => "h",
      schedule: (fn) => { h.timers.push({ fn, ms: 0 }); },
    });
    hub.subscribe(c => h.seen.push(c));
    hub.notify("herdr");
    h.runTimers();
    expect(h.seen[0]).toMatchObject({ fleetEtag: null, hooksEtag: "h" });
  });

  test("订阅者抛错被摘掉，不影响其他订阅者；current() 给首帧用", () => {
    const h = harness();
    h.hub.subscribe(() => { throw new Error("dead socket"); });
    h.hub.subscribe(c => h.seen.push(c));
    h.hub.notify("hook");
    h.runTimers();
    expect(h.hub.size).toBe(1);
    expect(h.seen).toHaveLength(1);
    expect(h.hub.current()).toEqual({ type: "changed", fleetEtag: "f1", hooksEtag: "h1", kinds: [] });
  });
});
