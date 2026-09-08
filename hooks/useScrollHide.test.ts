import { describe, expect, test } from "bun:test";
import { computeRevealScroll, createScrollHideStore } from "./useScrollHide";

// C2-3: reveal used to do `Math.min(maxScrollTop, scrollTop + shift)` — at
// (or near) the bottom that clamps the compensation and leaves a residual
// on-screen jump. computeRevealScroll is the extracted math: it must return
// a scrollTop that always fully lands on `desired`, reporting how much
// bottom padding the caller needs to lend the container to make that valid.
// (In today's LinearThreadView this branch is actually unreachable — see the
// comment on computeRevealScroll — so this is the only place the clamp fix
// itself gets exercised.)
describe("computeRevealScroll", () => {
  test("plenty of headroom: no padding needed, scrollTop lands exactly on desired", () => {
    const result = computeRevealScroll({
      scrollTop: 100,
      chromeShift: 104,
      scrollHeight: 2000,
      clientHeight: 800,
    });
    expect(result.scrollTop).toBe(204);
    expect(result.paddingBottom).toBe(0);
  });

  test("scrolled to the true bottom: old code would clamp, this lends back exactly the shortfall", () => {
    const scrollHeight = 1000;
    const clientHeight = 800;
    const maxScrollTop = scrollHeight - clientHeight; // 200
    const result = computeRevealScroll({
      scrollTop: maxScrollTop, // already at the bottom
      chromeShift: 104,
      scrollHeight,
      clientHeight,
    });
    // Old buggy behavior: Math.min(200, 200 + 104) = 200 (clamped, 104px jump).
    expect(result.scrollTop).toBe(maxScrollTop + 104);
    expect(result.paddingBottom).toBe(104);
  });

  test("partially clamped: padding covers only the actual shortfall", () => {
    const scrollHeight = 1000;
    const clientHeight = 800;
    const maxScrollTop = scrollHeight - clientHeight; // 200
    const result = computeRevealScroll({
      scrollTop: maxScrollTop - 40, // 40px of native headroom left
      chromeShift: 104,
      scrollHeight,
      clientHeight,
    });
    expect(result.scrollTop).toBe(maxScrollTop - 40 + 104);
    expect(result.paddingBottom).toBe(64); // 104 - 40
  });
});

// H-3: useScrollHide used to keep its `hidden` flag and listener set at
// module scope, so every mounted instance shared one flag. createScrollHideStore
// is the extracted factory each ScrollHideProvider now calls once — this
// proves two instances never see each other's state.
describe("createScrollHideStore", () => {
  test("independent stores don't share hidden state", () => {
    const a = createScrollHideStore();
    const b = createScrollHideStore();
    expect(a.getSnapshot()).toBe(false);
    expect(b.getSnapshot()).toBe(false);

    a.setHidden(true);
    expect(a.getSnapshot()).toBe(true);
    expect(b.getSnapshot()).toBe(false);

    b.setHidden(true);
    a.setHidden(false);
    expect(a.getSnapshot()).toBe(false);
    expect(b.getSnapshot()).toBe(true);
  });

  test("independent stores don't share listeners", () => {
    const a = createScrollHideStore();
    const b = createScrollHideStore();
    let aCalls = 0;
    let bCalls = 0;
    a.subscribe(() => aCalls++);
    b.subscribe(() => bCalls++);

    a.setHidden(true);
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(0);

    b.setHidden(true);
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);
  });

  test("setHidden is a no-op when the value doesn't change", () => {
    const store = createScrollHideStore();
    let calls = 0;
    store.subscribe(() => calls++);
    store.setHidden(false);
    expect(calls).toBe(0);
    store.setHidden(true);
    expect(calls).toBe(1);
    store.setHidden(true);
    expect(calls).toBe(1);
  });
});
