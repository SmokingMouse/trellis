import { describe, expect, test } from "bun:test";
import { herdrFetchPlan, herdrPollInterval } from "./herdr-push";

describe("Herdr 推送 → 拉取决策", () => {
  const local = { fleetEtag: "f", hooksEtag: "h" };
  test("只拉变了的那一半；都没变不拉", () => {
    expect(herdrFetchPlan({ type: "changed", fleetEtag: "f", hooksEtag: "h" }, local)).toBeNull();
    expect(herdrFetchPlan({ type: "changed", fleetEtag: "f2", hooksEtag: "h" }, local)).toEqual({ fleet: true, hooks: false });
    expect(herdrFetchPlan({ type: "changed", fleetEtag: "f", hooksEtag: "h2" }, local)).toEqual({ fleet: false, hooks: true });
  });
  test("服务端 ETag 缺失 / 本地尚无 ETag → 保守拉取；非法帧忽略", () => {
    expect(herdrFetchPlan({ type: "changed", fleetEtag: null, hooksEtag: "h" }, local)).toEqual({ fleet: true, hooks: false });
    expect(herdrFetchPlan({ type: "changed", fleetEtag: "f", hooksEtag: "h" }, { fleetEtag: null, hooksEtag: null })).toEqual({ fleet: true, hooks: true });
    expect(herdrFetchPlan(null, local)).toBeNull();
  });
  test("流在线轮询降为 30s 兜底，断流回到 2.5s", () => {
    expect(herdrPollInterval(true)).toBe(30_000);
    expect(herdrPollInterval(false)).toBe(2_500);
  });
});
