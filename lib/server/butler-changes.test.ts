import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

mock.module("server-only", () => ({}));

const testDir = mkdtempSync(path.join(tmpdir(), "trellis-butler-changes-"));
const prevDbPath = process.env.TRELLIS_DB_PATH;
process.env.TRELLIS_DB_PATH = path.join(testDir, "c.db");

const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const bc = await import("./butler-changes");
const { getAgent } = await import("./agents");
const { getTask, listTriggers } = await import("./tasks");
const { BUTLER_AGENT_ID } = await import("../butler");
const itemRoute = await import("../../app/api/butler/changes/[id]/route");

afterAll(() => {
  sqlite.resetDBForTests();
  if (prevDbPath === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = prevDbPath;
  rmSync(testDir, { recursive: true, force: true });
});

const db = sqlite.getDB();
const ins = db.prepare(
  "INSERT INTO sessions (id,title,root_node_id,created_at,updated_at,agent_id) VALUES (?,?,?,?,?,?)",
);
ins.run("butler", "管家", "n1", 1, 1, BUTLER_AGENT_ID);
ins.run("plain", "普通", "n2", 1, 1, null);

const propose = (method: string, p: string, body?: unknown, sessionId = "butler") =>
  bc.proposeChange({ sessionId, nodeId: "n1", method, path: p, body });

describe("proposeChange", () => {
  test("非管家会话 → null（调用方直连）", () => {
    expect(propose("POST", "/api/agents", { slug: "x", name: "X" }, "plain")).toBeNull();
  });

  test("白名单外的写 → ChangeError", () => {
    expect(() => propose("POST", "/api/tasks/abc/run")).toThrow(bc.ChangeError);
  });

  test("提案不落库：pending，目标对象不存在", () => {
    const c = propose("POST", "/api/agents", { slug: "pr-review", name: "PR 审查" })!;
    expect(c.status).toBe("pending");
    expect(c.kind).toBe("agent.create");
    expect(c.targetLabel).toBe("PR 审查");
    expect(db.prepare("SELECT 1 FROM agents WHERE slug = 'pr-review'").get()).toBeNull();
  });
});

describe("apply / revert 全周期", () => {
  test("agent：建 → 撤销 = 删掉", async () => {
    const c = propose("POST", "/api/agents", { slug: "writer2", name: "写作二号" })!;
    const applied = await bc.applyChange(c.id);
    expect(applied.status).toBe("applied");
    const id = (applied.result!.agent as { id: string }).id;
    expect(getAgent(id)?.name).toBe("写作二号");
    expect(applied.revertible).toBe(true);
    const reverted = await bc.revertChange(c.id);
    expect(reverted.status).toBe("reverted");
    expect(getAgent(id)).toBeNull();
  });

  test("task：改 → 撤销只写回改过的字段", async () => {
    const created = await bc.applyChange(propose("POST", "/api/tasks", { name: "日报", prompt: "old" })!.id);
    const tid = (created.result!.task as { id: string }).id;
    const up = propose("PATCH", `/api/tasks/${tid}`, { prompt: "new" })!;
    expect(up.before?.prompt).toBe("old");
    await bc.applyChange(up.id);
    expect(getTask(tid)?.prompt).toBe("new");
    await bc.revertChange(up.id);
    expect(getTask(tid)?.prompt).toBe("old");
    expect(getTask(tid)?.name).toBe("日报");
  });

  test("trigger：加 → 撤销；非法 cron 由原路由拦下 → failed", async () => {
    const tid = (
      (await bc.applyChange(propose("POST", "/api/tasks", { name: "T", prompt: "p" })!.id)).result!.task as { id: string }
    ).id;
    const bad = await bc.applyChange(propose("POST", `/api/tasks/${tid}/triggers`, { kind: "cron", config: { expr: "nope" } })!.id);
    expect(bad.status).toBe("failed");
    expect(bad.error).toContain("cron");
    const ok = await bc.applyChange(propose("POST", `/api/tasks/${tid}/triggers`, { kind: "cron", config: { expr: "0 9 * * *" } })!.id);
    expect(listTriggers(tid)).toHaveLength(1);
    await bc.revertChange(ok.id);
    expect(listTriggers(tid)).toHaveLength(0);
  });

  test("删除 = 高危：口令不对拒绝，对了才删，且不可撤销", async () => {
    const tid = (
      (await bc.applyChange(propose("POST", "/api/tasks", { name: "周报汇总", prompt: "p" })!.id)).result!.task as { id: string }
    ).id;
    const del = propose("DELETE", `/api/tasks/${tid}`)!;
    expect(del.risk).toBe("high");
    await expect(bc.applyChange(del.id, { confirm: "错的" })).rejects.toThrow("周报汇总");
    const done = await bc.applyChange(del.id, { confirm: "周报汇总" });
    expect(done.status).toBe("applied");
    expect(done.revertible).toBe(false);
    expect(getTask(tid)).toBeNull();
  });

  test("拒绝后不能再应用", async () => {
    const c = propose("POST", "/api/agents", { slug: "nope", name: "不要" })!;
    bc.rejectChange(c.id);
    await expect(bc.applyChange(c.id)).rejects.toThrow("rejected");
  });
});

describe("确认接口只收浏览器", () => {
  test("没有 Sec-Fetch-Mode（trellisctl / curl）→ 403", async () => {
    const c = propose("POST", "/api/agents", { slug: "self", name: "自批" })!;
    const call = (headers: Record<string, string>) =>
      itemRoute.POST(
        new Request(`http://x/api/butler/changes/${c.id}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ action: "apply" }),
        }),
        { params: Promise.resolve({ id: c.id }) },
      );
    expect((await call({})).status).toBe(403);
    expect((await call({ "sec-fetch-mode": "cors" })).status).toBe(200);
  });
});
