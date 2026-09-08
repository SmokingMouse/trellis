import { expect, test } from "bun:test";
import { herdrUnavailableText } from "../hooks/useHerdrFleet";
import type { HerdrFleetResponse } from "./herdr-ui";

const fleet: HerdrFleetResponse = {
  available: false, enabled: true, realtime: false, readOnly: true,
  protocol: null, version: null, workspaces: [], sessions: [],
  lastError: "ENOENT: ENOENT: no such file or directory, stat '/tmp/private/herdr.sock'",
};

test("missing socket gets a human-readable one-line status without exposing the raw error", () => {
  expect(herdrUnavailableText({ fleet, loading: false, error: null })).toBe("Herdr 未运行");
  expect(fleet.lastError).toContain("/tmp/private/herdr.sock");
});

test("loading, disabled and fetch failures remain distinct", () => {
  expect(herdrUnavailableText({ fleet, loading: true, error: null })).toBe("正在连接 Herdr…");
  expect(herdrUnavailableText({ fleet: { ...fleet, enabled: false }, loading: false, error: null })).toBe("Herdr 未启用");
  expect(herdrUnavailableText({ fleet: null, loading: false, error: "Failed to fetch" })).toBe("Herdr 暂时无法连接");
});
