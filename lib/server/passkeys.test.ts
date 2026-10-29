import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

// Passkey 存储 + challenge 绑定的服务端路径（签名校验本身由 simplewebauthn 负责，
// 端到端用 Chrome 虚拟认证器实测）。走真实 sqlite。

mock.module("server-only", () => ({}));
const dir = mkdtempSync(path.join(tmpdir(), "trellis-passkeys-"));
const previous = process.env.TRELLIS_DB_PATH;
process.env.TRELLIS_DB_PATH = path.join(dir, "data.db");
const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const pk = await import("./passkeys");

afterAll(() => {
  sqlite.resetDBForTests();
  if (previous === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = previous;
  rmSync(dir, { recursive: true, force: true });
});

const rp = { origin: "http://localhost:3484", rpId: "localhost" };

function fakeAssertion(challenge: string, id = "nope"): AuthenticationResponseJSON {
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge, origin: rp.origin }),
  ).toString("base64url");
  return {
    id,
    rawId: id,
    type: "public-key",
    clientExtensionResults: {},
    response: { clientDataJSON, authenticatorData: "", signature: "" },
  };
}

describe("passkeys", () => {
  test("登录 options：要求 UV、不列 credential", async () => {
    const o = await pk.beginLogin(rp);
    expect(o.rpId).toBe("localhost");
    expect(o.userVerification).toBe("required");
    expect(o.allowCredentials ?? []).toEqual([]);
  });

  test("注册 options：resident key + UV required", async () => {
    const o = await pk.beginRegistration(rp);
    expect(o.rp.id).toBe("localhost");
    expect(o.authenticatorSelection?.userVerification).toBe("required");
    expect(o.authenticatorSelection?.residentKey).toBe("required");
  });

  test("未知 credential 被拒，且 challenge 已作废（不能重放）", async () => {
    const o = await pk.beginLogin(rp);
    const first = await pk.finishLogin(rp, fakeAssertion(o.challenge));
    expect(first.ok).toBe(false);
    const again = await pk.finishLogin(rp, fakeAssertion(o.challenge));
    expect(again).toEqual({ ok: false, error: "challenge 无效或已过期，请重试" });
  });

  test("换 origin 交 verify 被拒", async () => {
    const o = await pk.beginLogin(rp);
    const r = await pk.finishLogin({ origin: "http://localhost:9999", rpId: "localhost" }, fakeAssertion(o.challenge));
    expect(r).toEqual({ ok: false, error: "来源不一致" });
  });

  test("注册 challenge 不能拿去登录", async () => {
    const o = await pk.beginRegistration(rp);
    const r = await pk.finishLogin(rp, fakeAssertion(o.challenge));
    expect(r).toEqual({ ok: false, error: "challenge 无效或已过期，请重试" });
  });

  test("坏 clientDataJSON", async () => {
    const r = await pk.finishLogin(rp, { ...fakeAssertion("x"), response: { clientDataJSON: "!!", authenticatorData: "", signature: "" } });
    expect(r.ok).toBe(false);
  });

  test("列表 / 删除", () => {
    sqlite
      .getDB()
      .prepare("INSERT INTO webauthn_credentials (id, public_key, name, rp_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("cred1", new Uint8Array([1, 2, 3]), "测试", "localhost", 1);
    const list = pk.listPasskeys();
    expect(list.map((p) => p.id)).toEqual(["cred1"]);
    expect(Object.keys(list[0])).not.toContain("publicKey");
    expect(pk.deletePasskey("cred1")).toBe(true);
    expect(pk.deletePasskey("cred1")).toBe(false);
    expect(pk.listPasskeys()).toEqual([]);
  });

  test("名称清洗", () => {
    expect(pk.sanitizePasskeyName("  我的 iPhone\u0000 ")).toBe("我的 iPhone");
    expect(pk.sanitizePasskeyName("x".repeat(100))).toHaveLength(64);
    expect(pk.sanitizePasskeyName(undefined, new Date(2026, 9, 29).getTime())).toBe("Passkey 2026-10-29");
  });
});
