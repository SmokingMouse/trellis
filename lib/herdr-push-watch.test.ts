import { describe, expect, test } from "bun:test";
import { approvalHook, askHook, herdrPanes, PANE_ID, SESSION_ID } from "./__fixtures__/herdr-push-fleet";
import { diffHerdrPush, HERDR_PUSH_FLICKER_MS, HERDR_PUSH_FRESH_MS, type HerdrPushState } from "./herdr-push-watch";

const T0 = 1_800_000_000_000;

describe("diffHerdrPush", () => {
  test("进入「需要你」立即出一条，标题信息（workspace · tab）与问的内容齐全；同一交互只出一次", () => {
    let state = diffHerdrPush(null, herdrPanes("working", null, T0), T0).state;
    const hook = approvalHook("tu-1", "rm -rf build", T0 + 1000);
    const d1 = diffHerdrPush(state, herdrPanes("blocked", hook, T0 + 1000), T0 + 1000);
    expect(d1.raised.map((r) => [r.pane.paneId, r.where, r.text, r.interaction])).toEqual([
      [PANE_ID, "trellis · review", "要执行 Bash：rm -rf build", "tu:tu-1"],
    ]);
    expect(d1.need).toEqual([{ paneId: PANE_ID, sessionId: SESSION_ID }]);
    state = d1.state;
    const d2 = diffHerdrPush(state, herdrPanes("blocked", { ...hook, updatedAt: T0 + 5000 }, T0 + 5000), T0 + 5000);
    expect(d2.raised).toEqual([]);
    expect(d2.left).toEqual([]);
  });

  test("还在 need 但换了一个交互（下一张卡）→ 再出一条", () => {
    let state = diffHerdrPush(null, herdrPanes("working", null, T0), T0).state;
    state = diffHerdrPush(state, herdrPanes("blocked", approvalHook("tu-1", "a", T0), T0), T0).state;
    const d = diffHerdrPush(state, herdrPanes("blocked", askHook("tu-2", "用哪个分支？", T0 + 10), T0 + 10), T0 + 10);
    expect(d.raised.map((r) => r.text)).toEqual(["提问：用哪个分支？"]);
  });

  test("离开 need → left；抖动窗口内同一张卡回来不重出，窗口外回来算新的一次", () => {
    let state: HerdrPushState = diffHerdrPush(null, herdrPanes("working", null, T0), T0).state;
    state = diffHerdrPush(state, herdrPanes("blocked", null, T0), T0).state; // 只靠读屏：键 = screen
    const left = diffHerdrPush(state, herdrPanes("working", null, T0 + 100), T0 + 100);
    expect(left.left).toEqual([PANE_ID]);
    const flicker = diffHerdrPush(left.state, herdrPanes("blocked", null, T0 + 200), T0 + 200);
    expect(flicker.raised).toEqual([]);
    const away = diffHerdrPush(flicker.state, herdrPanes("working", null, T0 + 300), T0 + 300);
    const back = diffHerdrPush(away.state, herdrPanes("blocked", null, T0 + 300 + HERDR_PUSH_FLICKER_MS), T0 + 300 + HERDR_PUSH_FLICKER_MS);
    expect(back.raised.length).toBe(1);
  });

  test("窗格消失也算离开 need", () => {
    const state = diffHerdrPush(diffHerdrPush(null, herdrPanes("working", null, T0), T0).state, herdrPanes("blocked", null, T0), T0).state;
    expect(diffHerdrPush(state, [], T0 + 1).left).toEqual([PANE_ID]);
  });

  test("进程里第一次算：只认刚冒出来的（hook 时间在 60s 内）", () => {
    const fresh = diffHerdrPush(null, herdrPanes("blocked", approvalHook("tu-1", "a", T0 - 1000), T0), T0);
    expect(fresh.raised.length).toBe(1);
    const stale = diffHerdrPush(null, herdrPanes("blocked", approvalHook("tu-1", "a", T0 - HERDR_PUSH_FRESH_MS - 1), T0), T0);
    expect(stale.raised).toEqual([]);
    // 判过不推的同一张卡，之后也不会再出
    expect(diffHerdrPush(stale.state, herdrPanes("blocked", approvalHook("tu-1", "a", T0 - HERDR_PUSH_FRESH_MS - 1), T0 + 1), T0 + 1).raised).toEqual([]);
  });

  test("干活 → 空闲 = ended；干活中 = working；第一次算不出 ended", () => {
    const first = diffHerdrPush(null, herdrPanes("working", null, T0), T0);
    expect(first.working).toEqual([PANE_ID]);
    expect(first.ended).toEqual([]);
    const done = diffHerdrPush(first.state, herdrPanes("idle", null, T0 + 1), T0 + 1);
    expect(done.ended.map((p) => p.paneId)).toEqual([PANE_ID]);
    expect(diffHerdrPush(done.state, herdrPanes("done", null, T0 + 2), T0 + 2).ended).toEqual([]);
  });
});
