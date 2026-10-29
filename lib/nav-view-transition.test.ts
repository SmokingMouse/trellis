import { describe, expect, test } from "bun:test";
import { navDirection, navViewKey } from "@/lib/nav-view-transition";

describe("nav view transition", () => {
  test("视图 key", () => {
    expect(navViewKey({ session: { id: "a" }, homeOpen: true, herdrOpen: false })).toBe("session:a");
    expect(navViewKey({ session: null, homeOpen: false, herdrOpen: true })).toBe("herdr");
    expect(navViewKey({ session: null, homeOpen: true, herdrOpen: false })).toBe("home");
    expect(navViewKey({ session: null, homeOpen: false, herdrOpen: false })).toBe("compose");
  });

  test("方向：进会话 forward，从会话退出 back，其余不播", () => {
    expect(navDirection("home", "session:a")).toBe("forward");
    expect(navDirection("session:a", "session:b")).toBe("forward");
    expect(navDirection("session:a", "home")).toBe("back");
    expect(navDirection("session:a", "herdr")).toBe("back");
    expect(navDirection("session:a", "session:a")).toBeNull();
    expect(navDirection("home", "home")).toBeNull();
    expect(navDirection("home", "herdr")).toBeNull();
  });
});
