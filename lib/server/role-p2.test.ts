import { afterAll, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 角色 P2 包 C（docs/roles-p2.md C）：管家的会话规划、任务 / 飞书的角色注入、
// 搜索与 @ 引用纳入角色 / 群聊会话、系统节点。临时 DB + 临时 TRELLIS_ROLES_DIR。

mock.module("server-only", () => ({}));

const testDir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "trellis-role-p2-")));
const prevDb = process.env.TRELLIS_DB_PATH;
const prevRoles = process.env.TRELLIS_ROLES_DIR;
process.env.TRELLIS_DB_PATH = path.join(testDir, "p2.db");
process.env.TRELLIS_ROLES_DIR = path.join(testDir, "roles");

const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const roles = await import("./roles");
const agents = await import("./agents");
const repo = await import("./repo");
const spawn = await import("./role-spawn");
const nodeRefs = await import("./node-refs");
const systemNode = await import("./system-node");
const { BUTLER_AGENT_ID } = await import("../butler");

afterAll(() => {
  sqlite.resetDBForTests();
  if (prevDb === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = prevDb;
  if (prevRoles === undefined) delete process.env.TRELLIS_ROLES_DIR;
  else process.env.TRELLIS_ROLES_DIR = prevRoles;
  fs.rmSync(testDir, { recursive: true, force: true });
});

function seed(id: string, opts: { kind?: string; agentId?: string | null; question?: string; mode?: string } = {}) {
  repo.createSessionWithRoot({
    sessionId: id,
    nodeId: `${id}-n1`,
    title: `标题 ${id}`,
    question: opts.question ?? `问题 ${id}`,
    now: Date.now(),
    mode: opts.mode ?? "chat",
    workspacePath: opts.mode === "project" ? testDir : null,
    agentId: opts.agentId ?? null,
    registerWorkspace: false,
  });
  sqlite.getDB().prepare("UPDATE nodes SET status = 'done', response = ? WHERE id = ?").run(`回答 ${id}`, `${id}-n1`);
  if (opts.kind) sqlite.getDB().prepare("UPDATE sessions SET kind = ? WHERE id = ?").run(opts.kind, id);
}

describe("管家是内置角色", () => {
  test("planRoleNewSession：管家保持 chat（不给 workspace），普通角色仍是 project", () => {
    const butler = roles.planRoleNewSession(BUTLER_AGENT_ID)!;
    expect(butler.mode).toBe("chat");
    expect(butler.workspacePath).toBeNull();
    const r = roles.createRole({ name: "老周" });
    const p = roles.planRoleNewSession(r.id)!;
    expect(p.mode).toBe("project");
    expect(p.workspacePath).toBe(r.homeDir);
  });

  test("管家在角色列表里，不在 Agent 列表里；记忆注入挂目录（chat 的 cwd 是 scratch）", () => {
    expect(roles.listRoles().some((r) => r.id === BUTLER_AGENT_ID)).toBe(true);
    expect(agents.listAgents().some((a) => a.id === BUTLER_AGENT_ID)).toBe(false);
    const rec = agents.getAgent(BUTLER_AGENT_ID)!;
    const extras = roles.roleSpawnExtras(rec, "/tmp/chat-scratch")!;
    expect(extras.addDirs).toEqual([path.join(testDir, "roles", "trellis-admin")]);
    expect(extras.appendSystemPrompt).toContain("你的长期记忆");
  });
});

describe("任务 / 飞书的角色注入", () => {
  test("resolveRoleAwareSpawn：角色 → 人设 + --add-dir 角色目录 + 记忆说明；mention / mock / 非角色不挂", () => {
    const r = roles.createRole({ name: "Spawn Role", systemPrompt: "我是审稿人" });
    const rec = agents.getAgent(r.id)!;
    const s = spawn.resolveRoleAwareSpawn(rec, "claude", testDir, testDir)!;
    expect(s.slug).toBe(r.slug);
    expect(JSON.parse(s.agentsJson!)[r.slug].prompt).toBe("我是审稿人");
    expect(s.addDirs).toEqual([r.homeDir]);
    expect(s.appendSystemPrompt).toContain(r.homeDir);
    // cwd 就是角色目录：不重复 --add-dir
    expect(spawn.resolveRoleAwareSpawn(rec, "claude", r.homeDir, r.homeDir)!.addDirs).toBeUndefined();
    // codex 同样带上（sdk-adapter 把记忆说明接在人设后）
    expect(spawn.resolveRoleAwareSpawn(rec, "codex", testDir, testDir)!.appendSystemPrompt).toBeTruthy();
    expect(spawn.resolveRoleAwareSpawn(rec, "claude", testDir, testDir, { mention: true })!.addDirs).toBeUndefined();
    expect(spawn.resolveRoleAwareSpawn(rec, "mock", testDir, testDir)).toBeNull();
    const plain = agents.listAgents()[0];
    const ps = spawn.resolveRoleAwareSpawn(plain, "claude", testDir, testDir)!;
    expect(ps.addDirs).toBeUndefined();
    expect(ps.appendSystemPrompt).toBeUndefined();
    // 记忆关掉：只给人设
    roles.updateRole(r.id, { memoryEnabled: false });
    expect(spawn.resolveRoleAwareSpawn(agents.getAgent(r.id)!, "claude", testDir, testDir)!.appendSystemPrompt).toBeUndefined();
  });

  test("roleDefaultWorkspace：project 没配目录 → 角色 work_dir / 角色目录；配了 / chat / 非角色原样", () => {
    const r = roles.createRole({ name: "Ws Role" });
    const rec = agents.getAgent(r.id)!;
    fs.rmSync(r.homeDir, { recursive: true, force: true });
    expect(spawn.roleDefaultWorkspace(rec, "project", null)).toBe(r.homeDir);
    expect(fs.existsSync(r.homeDir)).toBe(true); // launch 先验目录：得先建出来
    roles.updateRole(r.id, { workDir: testDir });
    expect(spawn.roleDefaultWorkspace(agents.getAgent(r.id)!, "project", null)).toBe(testDir);
    expect(spawn.roleDefaultWorkspace(rec, "project", "/x")).toBe("/x");
    expect(spawn.roleDefaultWorkspace(rec, "chat", null)).toBeNull();
    expect(spawn.roleDefaultWorkspace(agents.listAgents()[0], "project", null)).toBeNull();
  });

  test("任务与飞书的 spawn 都走 resolveRoleAwareSpawn（源码守卫）", () => {
    const tasks = fs.readFileSync(path.join(import.meta.dir, "tasks.ts"), "utf8");
    expect(tasks).toContain("resolveRoleAwareSpawn(agentRecord, family, task.workspacePath, spawnCwd)");
    expect(tasks).toContain("roleDefaultWorkspace(");
    const lark = fs.readFileSync(path.join(import.meta.dir, "lark", "handler.ts"), "utf8");
    expect(lark).toContain("resolveRoleAwareSpawn(agentRecord, family, bot.workspacePath, spawnCwd, { mention: !!mention })");
    expect(lark).not.toContain("resolveAgentSpawn(");
  });
});

describe("搜索 / @ 引用纳入角色与群聊", () => {
  test("searchAll 带角色标记；@ 候选包含 role / group，不含 task 以外的内部会话", () => {
    const r = roles.createRole({ name: "搜索角色", avatarHue: 150, avatarGlyph: "搜" });
    seed("s-role", { kind: "role", agentId: r.id, question: "量子退火怎么调" });
    seed("s-group", { kind: "group", question: "量子退火群聊讨论" });
    seed("s-user", { question: "量子退火普通会话" });
    seed("s-internal", { kind: "scratch", question: "量子退火内部会话" });

    const hits = repo.searchAll("量子退火");
    const byId = new Map(hits.map((h) => [h.sessionId, h]));
    expect(byId.get("s-role")).toMatchObject({ sessionKind: "role", role: { id: r.id, name: "搜索角色", avatarHue: 150, avatarGlyph: "搜" } });
    expect(byId.get("s-group")).toMatchObject({ sessionKind: "group", role: null });
    expect(byId.get("s-user")).toMatchObject({ sessionKind: "user", role: null });

    const cands = nodeRefs.listRefCandidates("量子退火");
    const ids = cands.map((c) => c.sessionId).sort();
    expect(ids).toEqual(["s-group", "s-role", "s-user"]);
    expect(cands.find((c) => c.sessionId === "s-role")!.role?.name).toBe("搜索角色");
    expect(nodeRefs.listRefNodes("s-role")).not.toBeNull();
    expect(nodeRefs.listRefNodes("s-group")).not.toBeNull();
    expect(nodeRefs.listRefNodes("s-internal")).toBeNull();
    expect(nodeRefs.resolveNodeRef({ sessionId: "s-role", nodeId: "s-role-n1" } as never)?.response).toBe("回答 s-role");
  });
});

describe("系统节点", () => {
  test("appendSystemNode：已完成的新根、带 meta、正文进全文索引；不当 @ 默认引用节点", () => {
    seed("s-sys", { kind: "role" });
    const { nodeId } = systemNode.appendSystemNode({
      sessionId: "s-sys",
      title: "跟进：1 个失败",
      body: "- [ ] **失败** [某会话](/?session=x) — 超时独角兽",
      kind: "role-follow",
      meta: { items: [] },
    });
    const n = repo.getNode(nodeId)!;
    expect(n).toMatchObject({ parentId: null, status: "done", question: "跟进：1 个失败" });
    expect(n.meta).toEqual({ items: [], kind: "role-follow" });
    expect(repo.getNode("s-sys-n1")!.meta).toBeNull();
    expect(repo.searchAll("超时独角兽").map((h) => h.sessionId)).toEqual(["s-sys"]);
    expect(nodeRefs.listRefCandidates("").find((c) => c.sessionId === "s-sys")?.latest?.nodeId).toBe("s-sys-n1");
  });
});
