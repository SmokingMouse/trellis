import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

mock.module("server-only", () => ({}));
// 真探测会 spawn claude/codex status、读发布目录 —— 测试里只验汇总形状。
mock.module("./auth-health", () => ({
  getAuthHealth: async () => {
    const cli = (loggedIn: boolean) => ({
      installed: true, loggedIn, method: null, subscription: null, account: null,
      accessExpiresAt: null, refreshExpiresAt: null, credentialUpdatedAt: null,
      warnings: [], errors: loggedIn ? [] : ["未登录"],
    });
    return { claude: cli(true), codex: cli(false), checkedAt: 0 };
  },
  // bun 的 mock 进程内共享，且只能原地改已有导出名：调度器（task-scheduler）也 import 这个，
  // 别的测试文件 import 调度器时少了这个名字会直接链接失败。
  checkAuthAlerts: async () => {},
}));
mock.module("./update", () => ({
  updateStatus: () => {
    throw new Error("no release dir");
  },
}));

const testDir = mkdtempSync(path.join(tmpdir(), "trellis-butler-"));
// bun 同进程跑所有测试文件：收尾时还原 env，别让后面的文件（如 disk-watch 的
// 真机 statfs）拿到一个已删目录。
const prevDbPath = process.env.TRELLIS_DB_PATH;
process.env.TRELLIS_DB_PATH = path.join(testDir, "butler.db");

const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const butler = await import("./butler");
const { BUTLER_AGENT_ID } = await import("../butler");
const presets = await import("../agent-presets");

afterAll(() => {
  sqlite.resetDBForTests();
  if (prevDbPath === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = prevDbPath;
  rmSync(testDir, { recursive: true, force: true });
});

describe("管家迁成内置角色 + latestButlerSessionId", () => {
  test("空库：管家已是 kind=role、没有固定会话", () => {
    const row = sqlite.getDB().prepare("SELECT kind, home_session_id, avatar_glyph, intro FROM agents WHERE id = ?").get(BUTLER_AGENT_ID) as {
      kind: string; home_session_id: string | null; avatar_glyph: string; intro: string;
    };
    expect(row.kind).toBe("role");
    expect(row.home_session_id).toBeNull();
    expect(row.avatar_glyph).toBe("管");
    expect(row.intro).toBe("配置 Trellis");
    expect((sqlite.getDB().prepare("SELECT name FROM agents WHERE id = ?").get(BUTLER_AGENT_ID) as { name: string }).name).toBe("管家");
    expect(butler.latestButlerSessionId()).toBeNull();
  });

  test("迁移：最近一条未归档的 user 管家会话成固定会话（kind=role），其余不动；幂等", () => {
    const db = sqlite.getDB();
    // 模拟迁移前的库：管家还是普通 agent
    db.prepare("UPDATE agents SET kind = 'agent', home_session_id = NULL WHERE id = ?").run(BUTLER_AGENT_ID);
    const ins = db.prepare(
      "INSERT INTO sessions (id,title,root_node_id,created_at,updated_at,agent_id,archived,kind) VALUES (?,?,?,?,?,?,?,?)",
    );
    ins.run("old", "管家", "n1", 1, 10, BUTLER_AGENT_ID, 0, "user");
    ins.run("newest-archived", "管家", "n2", 1, 40, BUTLER_AGENT_ID, 1, "user");
    ins.run("task-run", "任务", "n3", 1, 30, BUTLER_AGENT_ID, 0, "task");
    ins.run("other-agent", "别的", "n4", 1, 50, null, 0, "user");
    ins.run("recent", "管家", "n5", 1, 20, BUTLER_AGENT_ID, 0, "user");
    sqlite.migrateButlerToRole(db);
    const kinds = Object.fromEntries(
      (db.prepare("SELECT id, kind FROM sessions").all() as { id: string; kind: string }[]).map((r) => [r.id, r.kind]),
    );
    expect(kinds).toEqual({ old: "user", "newest-archived": "user", "task-run": "task", "other-agent": "user", recent: "role" });
    expect(butler.latestButlerSessionId()).toBe("recent");

    // 再跑一次（下次启动）：用户改过的头像、归档掉的固定会话都不被改回来
    db.prepare("UPDATE agents SET avatar_glyph = '家' WHERE id = ?").run(BUTLER_AGENT_ID);
    db.prepare("UPDATE sessions SET archived = 1 WHERE id = 'recent'").run();
    sqlite.migrateButlerToRole(db);
    expect((db.prepare("SELECT kind FROM sessions WHERE id = 'old'").get() as { kind: string }).kind).toBe("user");
    expect((db.prepare("SELECT avatar_glyph FROM agents WHERE id = ?").get(BUTLER_AGENT_ID) as { avatar_glyph: string }).avatar_glyph).toBe("家");
    // 固定会话归档了 → 不捡别的历史会话，落草稿
    expect(butler.latestButlerSessionId()).toBeNull();
  });
});

describe("butlerOverview", () => {
  test("各节独立：读挂的节带 error，其余照常", async () => {
    const o = await butler.butlerOverview();
    expect(o.agents.ok).toBe(true);
    // 管家是角色，不算进 Agent 数
    if (o.agents.ok) expect(o.agents.total).toBe(presets.BUILTIN_AGENT_SEEDS.length - 1);
    expect(o.tasks.ok && o.tasks.total).toBe(0);
    expect(o.bots.ok && o.bots.total).toBe(0);
    expect(o.auth.ok).toBe(true);
    if (o.auth.ok) expect(o.auth.clis.map((c) => c.loggedIn)).toEqual([true, false]);
    expect(o.version).toEqual({ ok: false, error: "no release dir" });
  });
});

describe("upgradeBuiltinPrompts", () => {
  const get = () =>
    (sqlite.getDB().prepare("SELECT system_prompt FROM agents WHERE id = ?").get(BUTLER_AGENT_ID) as {
      system_prompt: string;
    }).system_prompt;

  test("新库直接是当前版人设", () => {
    expect(get()).toBe(presets.TRELLIS_ADMIN_PROMPT);
  });

  test("旧版原文 → 升级；用户改过 → 不碰", () => {
    const db = sqlite.getDB();
    const set = db.prepare("UPDATE agents SET system_prompt = ? WHERE id = ?");
    set.run(presets.PREVIOUS_BUILTIN_PROMPTS["trellis-admin"][0], BUTLER_AGENT_ID);
    sqlite.upgradeBuiltinPrompts(db);
    expect(get()).toBe(presets.TRELLIS_ADMIN_PROMPT);

    set.run("我自己改的人设", BUTLER_AGENT_ID);
    sqlite.upgradeBuiltinPrompts(db);
    expect(get()).toBe("我自己改的人设");
  });
});
