import { afterAll, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 角色 P1（docs/roles-p1.md）后端：目录、记忆读写、MEMORY.md 重建、prompt、
// chat 路由的固定会话判定。临时 DB + 临时 TRELLIS_ROLES_DIR，不碰真 HOME。

mock.module("server-only", () => ({}));

const testDir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "trellis-roles-")));
const prevDb = process.env.TRELLIS_DB_PATH;
const prevRoles = process.env.TRELLIS_ROLES_DIR;
process.env.TRELLIS_DB_PATH = path.join(testDir, "roles.db");
const rolesDir = path.join(testDir, "roles");
process.env.TRELLIS_ROLES_DIR = rolesDir;

const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const roles = await import("./roles");
const agents = await import("./agents");
const repo = await import("./repo");
const { detachHomeSession } = await import("./tasks");

afterAll(() => {
  sqlite.resetDBForTests();
  if (prevDb === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = prevDb;
  if (prevRoles === undefined) delete process.env.TRELLIS_ROLES_DIR;
  else process.env.TRELLIS_ROLES_DIR = prevRoles;
  fs.rmSync(testDir, { recursive: true, force: true });
});

function expectRoleError(fn: () => unknown, status: number) {
  let caught: unknown = null;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(roles.RoleError);
  expect((caught as InstanceType<typeof roles.RoleError>).status).toBe(status);
}

function seedSession(id: string, agentId: string | null, workspacePath: string) {
  repo.createSessionWithRoot({
    sessionId: id,
    nodeId: `${id}-root`,
    title: "t",
    question: "q",
    now: Date.now(),
    mode: "project",
    workspacePath,
    agentId,
    registerWorkspace: false,
  });
}

describe("迁移与 agents 隔离", () => {
  test("agents 有角色列，默认值正确", () => {
    const cols = (sqlite.getDB().query("SELECT name, dflt_value FROM pragma_table_info('agents')").all() as {
      name: string;
      dflt_value: string | null;
    }[]);
    const byName = new Map(cols.map((c) => [c.name, c.dflt_value]));
    for (const c of ["kind", "intro", "avatar_hue", "avatar_glyph", "work_dir", "memory_enabled", "home_session_id"]) {
      expect(byName.has(c)).toBeTrue();
    }
    expect(byName.get("kind")).toBe("'agent'");
    expect(byName.get("avatar_hue")).toBe("254");
    expect(byName.get("memory_enabled")).toBe("1");
  });

  test("listAgents 排除角色，resolveEnabledAgent 仍能解析角色", () => {
    const r = roles.createRole({ name: "Hidden From Agents" });
    expect(agents.listAgents().some((a) => a.id === r.id)).toBeFalse();
    expect(agents.listAgents({ enabledOnly: true }).some((a) => a.id === r.id)).toBeFalse();
    expect(agents.listAgents({ kind: "role" }).some((a) => a.id === r.id)).toBeTrue();
    expect(agents.resolveEnabledAgent(r.id)?.kind).toBe("role");
    // 内置 agent 照常
    expect(agents.listAgents().every((a) => a.kind === "agent")).toBeTrue();
    expect(agents.listAgents().length).toBeGreaterThan(0);
  });
});

describe("slug 与新建", () => {
  test("ASCII 名字 → 连字符 slug，冲突加 -2", () => {
    const a = roles.createRole({ name: "Code Reviewer!" });
    const b = roles.createRole({ name: "code reviewer" });
    expect(a.slug).toBe("code-reviewer");
    expect(b.slug).toBe("code-reviewer-2");
  });

  test("中文名回落 role-<6位随机>", () => {
    const r = roles.createRole({ name: "小助手" });
    expect(r.slug).toMatch(/^role-[a-z0-9]{6}$/);
  });

  test("显式 slug 被占 → 409；非法 → 400", () => {
    roles.createRole({ name: "x", slug: "taken-slug" });
    expectRoleError(() => roles.createRole({ name: "y", slug: "taken-slug" }), 409);
    expectRoleError(() => roles.createRole({ name: "y", slug: "Bad Slug" }), 400);
  });

  test("建目录骨架 + 字段落库", () => {
    const r = roles.createRole({
      name: "Writer",
      intro: "写东西的",
      systemPrompt: "你是写手",
      avatarHue: 35,
      avatarGlyph: "写",
      memoryEnabled: false,
    });
    expect(r.homeDir).toBe(path.join(rolesDir, "writer"));
    expect(fs.readFileSync(path.join(r.homeDir, "USER.md"), "utf8")).toBe("");
    expect(fs.readFileSync(path.join(r.homeDir, "MEMORY.md"), "utf8")).toBe("");
    expect(fs.statSync(path.join(r.homeDir, "memories")).isDirectory()).toBeTrue();
    expect(r).toMatchObject({
      intro: "写东西的",
      systemPrompt: "你是写手",
      avatarHue: 35,
      avatarGlyph: "写",
      memoryEnabled: false,
      workDir: null,
      homeSessionId: null,
      lastActiveAt: null,
      memoryCount: 0,
      builtin: false,
      enabled: true,
    });
    const rec = agents.getAgent(r.id)!;
    expect(rec.inheritEnv).toBeTrue();
    expect(rec.description).toBe("写东西的");
  });
});

describe("parseRoleInput", () => {
  test("校验", () => {
    expectRoleError(() => roles.parseRoleInput({}, false), 400);
    expectRoleError(() => roles.parseRoleInput({ name: "  " }, false), 400);
    expectRoleError(() => roles.parseRoleInput({ name: "a", avatarHue: 360 }, false), 400);
    expectRoleError(() => roles.parseRoleInput({ name: "a", avatarHue: 1.5 }, false), 400);
    expectRoleError(() => roles.parseRoleInput({ name: "a", avatarHue: -1 }, false), 400);
    expectRoleError(() => roles.parseRoleInput({ name: "a", workDir: "rel/path" }, false), 400);
    expectRoleError(() => roles.parseRoleInput({ name: "a", workDir: path.join(testDir, "nope") }, false), 400);
    const file = path.join(testDir, "a-file");
    fs.writeFileSync(file, "x");
    expectRoleError(() => roles.parseRoleInput({ name: "a", workDir: file }, false), 400);
    expectRoleError(() => roles.parseRoleInput({ slug: "x" }, true), 400);
    expectRoleError(() => roles.parseRoleInput({ memoryEnabled: "yes" }, true), 400);
    expectRoleError(() => roles.parseRoleInput(null, true), 400);
    expect(roles.parseRoleInput({ name: " A ", avatarHue: 0, workDir: testDir, model: " " }, false)).toEqual({
      name: "A",
      avatarHue: 0,
      workDir: testDir,
      model: null,
    });
    expect(roles.parseRoleInput({ workDir: "" }, true)).toEqual({ workDir: null });
    expect(roles.parseRoleInput({}, true)).toEqual({});
  });
});

describe("改与删", () => {
  test("updateRole 同步 description；换 workDir 带着固定会话搬", () => {
    const r = roles.createRole({ name: "Mover" });
    seedSession("s-mover", r.id, r.homeDir);
    roles.adoptRoleHomeSession(r.id, "s-mover");
    const work = fs.mkdtempSync(path.join(testDir, "work-"));
    const u = roles.updateRole(r.id, { intro: "新介绍", workDir: work });
    expect(u.intro).toBe("新介绍");
    expect(u.workDir).toBe(work);
    expect(agents.getAgent(r.id)!.description).toBe("新介绍");
    expect(repo.getSession("s-mover")!.workspacePath).toBe(work);
    roles.updateRole(r.id, { workDir: null });
    expect(repo.getSession("s-mover")!.workspacePath).toBe(r.homeDir);
  });

  test("deleteRole：目录改名留底、行删除、会话保留；内置 409；不存在 404", () => {
    const r = roles.createRole({ name: "Goner" });
    fs.writeFileSync(path.join(r.homeDir, "USER.md"), "keep me");
    seedSession("s-goner", r.id, r.homeDir);
    roles.adoptRoleHomeSession(r.id, "s-goner");
    roles.deleteRole(r.id);
    expect(roles.getRole(r.id)).toBeNull();
    expect(fs.existsSync(r.homeDir)).toBeFalse();
    const left = fs.readdirSync(rolesDir).filter((n) => n.startsWith("goner.deleted-"));
    expect(left).toHaveLength(1);
    expect(fs.readFileSync(path.join(rolesDir, left[0], "USER.md"), "utf8")).toBe("keep me");
    expect(repo.getSession("s-goner")).not.toBeNull();

    const b = roles.createRole({ name: "Builtin Role" });
    sqlite.getDB().prepare("UPDATE agents SET builtin = 1 WHERE id = ?").run(b.id);
    expectRoleError(() => roles.deleteRole(b.id), 409);
    expectRoleError(() => roles.deleteRole("no-such"), 404);
    // 普通 agent 不是角色
    expectRoleError(() => roles.deleteRole("builtin-" + agents.listAgents()[0].slug), 404);
  });
});

describe("记忆", () => {
  test("写 / 列 / 删 + MEMORY.md 重建", () => {
    const r = roles.createRole({ name: "Mem" });
    const m = roles.writeRoleMemory(r.id, "prefers-short.md", {
      name: "prefers-short",
      description: "喜欢短回答: 别啰嗦",
      type: "feedback",
      body: "用户说过「短点」。",
    });
    expect(m).toMatchObject({ file: "prefers-short.md", name: "prefers-short", description: "喜欢短回答: 别啰嗦", type: "feedback" });
    expect(m.body).toBe("用户说过「短点」。\n");
    roles.writeRoleMemory(r.id, "a-ref.md", { name: "docs", description: "", type: "reference", body: "x" });

    const raw = fs.readFileSync(path.join(r.homeDir, "memories", "prefers-short.md"), "utf8");
    expect(raw.startsWith("---\nname: prefers-short\ndescription: \"喜欢短回答: 别啰嗦\"\nmetadata:\n  type: feedback\n---\n")).toBeTrue();

    expect(fs.readFileSync(path.join(r.homeDir, "MEMORY.md"), "utf8")).toBe(
      "- [docs](memories/a-ref.md)\n- [prefers-short](memories/prefers-short.md) — 喜欢短回答: 别啰嗦\n",
    );
    const list = roles.listRoleMemories(r.id);
    expect(list.memoryEnabled).toBeTrue();
    expect(list.memories.map((x) => x.file).sort()).toEqual(["a-ref.md", "prefers-short.md"]);
    expect(roles.getRole(r.id)!.memoryCount).toBe(2);

    roles.deleteRoleMemory(r.id, "a-ref.md");
    expect(fs.readFileSync(path.join(r.homeDir, "MEMORY.md"), "utf8")).toBe(
      "- [prefers-short](memories/prefers-short.md) — 喜欢短回答: 别啰嗦\n",
    );
    expectRoleError(() => roles.deleteRoleMemory(r.id, "a-ref.md"), 404);

    roles.writeRoleUserMd(r.id, "用户叫小明");
    expect(roles.listRoleMemories(r.id).userMd).toBe("用户叫小明");
    expectRoleError(() => roles.writeRoleUserMd(r.id, 42), 400);
    expectRoleError(() => roles.listRoleMemories("no-such"), 404);
  });

  test("路径穿越 / 非法文件名 / 软链一律拒绝", () => {
    const r = roles.createRole({ name: "Guard" });
    const input = { name: "n", description: "", type: "user" as const, body: "b" };
    for (const bad of ["../escape.md", "a/b.md", ".hidden.md", "Upper.md", "x.txt", "x", "-a.md", "a".repeat(82) + ".md", "..%2fx.md"]) {
      expectRoleError(() => roles.writeRoleMemory(r.id, bad, input), 400);
      expectRoleError(() => roles.deleteRoleMemory(r.id, bad), 400);
    }
    expect(fs.existsSync(path.join(rolesDir, "escape.md"))).toBeFalse();

    // memories/ 下的软链文件：不能借它写到外面
    const outside = path.join(testDir, "outside.md");
    fs.writeFileSync(outside, "orig");
    fs.symlinkSync(outside, path.join(r.homeDir, "memories", "link.md"));
    expectRoleError(() => roles.writeRoleMemory(r.id, "link.md", input), 400);
    expect(fs.readFileSync(outside, "utf8")).toBe("orig");
    // 列表也不认软链
    expect(roles.listRoleMemories(r.id).memories.map((m) => m.file)).not.toContain("link.md");

    // memories/ 本身被换成指向外面的软链
    const r2 = roles.createRole({ name: "Guard Two" });
    const elsewhere = fs.mkdtempSync(path.join(testDir, "elsewhere-"));
    fs.rmSync(path.join(r2.homeDir, "memories"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(r2.homeDir, "memories"));
    expectRoleError(() => roles.writeRoleMemory(r2.id, "ok.md", input), 400);
    expect(fs.readdirSync(elsewhere)).toHaveLength(0);
  });

  test("parseMemoryInput 校验", () => {
    expectRoleError(() => roles.parseMemoryInput({ description: "", type: "user", body: "" }), 400);
    expectRoleError(() => roles.parseMemoryInput({ name: "n", type: "nope", body: "" }), 400);
    expectRoleError(() => roles.parseMemoryInput({ name: "n", type: "user" }), 400);
    expect(roles.parseMemoryInput({ name: " n ", type: "project", body: "b" })).toEqual({
      name: "n",
      description: "",
      type: "project",
      body: "b",
    });
  });

  test("parseMemoryFile 容错", () => {
    expect(roles.parseMemoryFile("plain.md", "no frontmatter here", 1)).toMatchObject({
      name: "plain",
      description: "",
      type: "project",
      body: "no frontmatter here",
    });
    expect(roles.parseMemoryFile("unterminated.md", "---\nname: x\nbody", 1).name).toBe("unterminated");
    const cc = "---\nname: repo-dirs\ndescription: \"带引号: 的描述\"\nmetadata: \n  node_type: memory\n  type: project\n  originSessionId: abc\n---\n\n正文\n";
    expect(roles.parseMemoryFile("repo-dirs.md", cc, 5)).toMatchObject({
      name: "repo-dirs",
      description: "带引号: 的描述",
      type: "project",
      body: "正文\n",
      updatedAt: 5,
    });
    expect(roles.parseMemoryFile("t.md", "---\nname: 'it''s'\ntype: user\n---\nb", 1)).toMatchObject({ name: "it's", type: "user" });
    expect(roles.parseMemoryFile("t.md", "---\nname: x\nmetadata:\n  type: weird\n---\nb", 1).type).toBe("project");
    // 往返
    const text = roles.serializeMemory({ name: "- dash", description: "a #b", type: "user", body: "line\n" });
    expect(roles.parseMemoryFile("rt.md", text, 1)).toMatchObject({ name: "- dash", description: "a #b", type: "user", body: "line\n" });
  });
});

describe("spawn 注入", () => {
  test("buildRoleMemoryPrompt 带目录、写法、USER.md 与 MEMORY.md 全文", () => {
    const r = roles.createRole({ name: "Prompted" });
    roles.writeRoleUserMd(r.id, "用户偏好中文");
    roles.writeRoleMemory(r.id, "likes-tables.md", { name: "likes-tables", description: "爱看表格", type: "feedback", body: "b" });
    const text = roles.buildRoleMemoryPrompt(r);
    expect(text).toContain(r.homeDir);
    expect(text).toContain(path.join(r.homeDir, "memories"));
    expect(text).toContain("MEMORY.md");
    expect(text).toContain("metadata:");
    expect(text).toContain("type: feedback");
    expect(text).toContain("什么值得记");
    expect(text).toContain("不记");
    expect(text).toContain("用户偏好中文");
    expect(text).toContain("- [likes-tables](memories/likes-tables.md) — 爱看表格");
    expect(text).toContain("「Prompted」");

    const empty = roles.createRole({ name: "Empty Prompt" });
    expect(roles.buildRoleMemoryPrompt(empty)).toContain("（还没有记忆）");
  });

  test("roleSpawnExtras：cwd 是角色目录时不重复 add-dir；记忆关掉 / 非角色 → null", () => {
    const r = roles.createRole({ name: "Spawner" });
    const rec = agents.getAgent(r.id)!;
    const inHome = roles.roleSpawnExtras(rec, r.homeDir)!;
    expect(inHome.addDirs).toBeUndefined();
    expect(inHome.appendSystemPrompt).toContain(r.homeDir);
    const elsewhere = roles.roleSpawnExtras(rec, testDir)!;
    expect(elsewhere.addDirs).toEqual([r.homeDir]);

    roles.updateRole(r.id, { memoryEnabled: false });
    expect(roles.roleSpawnExtras(agents.getAgent(r.id)!, testDir)).toBeNull();
    expect(roles.roleSpawnExtras(agents.listAgents()[0], testDir)).toBeNull();
  });
});

describe("固定会话", () => {
  test("planRoleNewSession / adopt / 归档清指针 / 侧栏不可见", () => {
    const r = roles.createRole({ name: "Homey" });
    expect(roles.planRoleNewSession("not-a-role")).toBeNull();
    expect(roles.planRoleNewSession(agents.listAgents()[0].id)).toBeNull();
    expect(roles.planRoleNewSession(undefined)).toBeNull();

    const p1 = roles.planRoleNewSession(r.id)!;
    expect(p1.reuseSessionId).toBeNull();
    expect(p1.workspacePath).toBe(r.homeDir);
    expect(p1.homeDir).toBe(r.homeDir);
    expect(p1.mode).toBe("project");

    seedSession("s-home", r.id, p1.workspacePath!);
    roles.adoptRoleHomeSession(r.id, "s-home");
    expect(repo.getSession("s-home")!.kind).toBe("role");
    expect(roles.planRoleNewSession(r.id)!.reuseSessionId).toBe("s-home");
    expect(roles.openRole(r.id)).toEqual({ sessionId: "s-home" });
    expect(roles.getRole(r.id)!.homeSessionId).toBe("s-home");
    expect(roles.getRole(r.id)!.lastActiveAt).not.toBeNull();
    expect(repo.listSessions().some((s) => s.id === "s-home")).toBeFalse();

    // 归档 → 路由调 detachHomeSession → 指针清掉，下一条消息重建
    repo.setSessionArchived("s-home", true, Date.now());
    detachHomeSession("s-home");
    expect(agents.getAgent(r.id)!.homeSessionId).toBeNull();
    expect(roles.planRoleNewSession(r.id)!.reuseSessionId).toBeNull();
    expect(roles.openRole(r.id)).toEqual({ sessionId: null });
  });

  test("指针悬挂（会话被删）当作没有；workDir 被删回落角色目录；停用 → null", () => {
    const work = fs.mkdtempSync(path.join(testDir, "wd-"));
    const r = roles.createRole({ name: "Dangling", workDir: work });
    sqlite.getDB().prepare("UPDATE agents SET home_session_id = 'ghost' WHERE id = ?").run(r.id);
    const p = roles.planRoleNewSession(r.id)!;
    expect(p.reuseSessionId).toBeNull();
    expect(p.workspacePath).toBe(work);
    fs.rmSync(work, { recursive: true });
    expect(roles.planRoleNewSession(r.id)!.workspacePath).toBe(r.homeDir);
    agents.updateAgent(r.id, { enabled: false });
    expect(roles.planRoleNewSession(r.id)).toBeNull();
  });

  test("listRoles：聊过的按 lastActiveAt 降序在前，没聊过的按创建顺序", () => {
    const names = roles.listRoles().map((x) => x.name);
    expect(names.length).toBeGreaterThan(3);
    const all = roles.listRoles();
    const active = all.filter((x) => x.lastActiveAt !== null);
    const firstIdle = all.findIndex((x) => x.lastActiveAt === null);
    expect(all.slice(0, active.length)).toEqual(active);
    for (let i = 1; i < active.length; i++) {
      expect(active[i - 1].lastActiveAt!).toBeGreaterThanOrEqual(active[i].lastActiveAt!);
    }
    const idle = all.slice(firstIdle);
    for (let i = 1; i < idle.length; i++) {
      expect(idle[i - 1].createdAt).toBeLessThanOrEqual(idle[i].createdAt);
    }
  });
});

describe("POST /api/chat 角色分支（mock 引擎）", () => {
  async function send(body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "mock", ...body }),
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text(); // 跑完整个 SSE
    const first = JSON.parse(text.split("\n\n")[0].replace(/^data: /, "")) as {
      type: string;
      session?: { id: string; kind?: string; mode: string; workspacePath: string | null; agentId?: string | null };
      node: { id: string; sessionId: string };
    };
    expect(first.type).toBe("created");
    return first;
  }

  test("首条消息建固定会话；再发新会话请求 → 复用同一会话开新根；/new 走 sessionId", async () => {
    const r = roles.createRole({ name: "Chatty" });
    // 客户端瞎填的 mode / workspacePath 不算数
    const a = await send({ kind: "root", question: "你好", agentId: r.id, mode: "chat", workspacePath: "/tmp" });
    expect(a.session).toBeDefined();
    const sid = a.session!.id;
    expect(a.session!.mode).toBe("project");
    expect(a.session!.workspacePath).toBe(r.homeDir);
    expect(a.session!.kind).toBe("role");
    expect(agents.getAgent(r.id)!.homeSessionId).toBe(sid);
    expect(repo.getSession(sid)!.agentId).toBe(r.id);
    // 角色目录没被登记成项目
    expect(repo.getSession(sid)!.workspaceId).toBeNull();

    const b = await send({ kind: "root", question: "又来了", agentId: r.id, mode: "project", workspacePath: r.homeDir });
    expect(b.node.sessionId).toBe(sid);
    expect(b.session?.id).toBe(sid);

    const c = await send({ kind: "root", sessionId: sid, question: "/new 新话题" });
    expect(c.node.sessionId).toBe(sid);
    expect(c.session).toBeUndefined();

    const roots = repo.getSessionNodes(sid).filter((n) => n.parentId === null);
    expect(roots).toHaveLength(3);
  }, 60_000);
});

describe("API 路由", () => {
  const json = (method: string, body?: unknown) =>
    new Request("http://localhost/x", {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  const params = <T,>(p: T) => ({ params: Promise.resolve(p) });

  test("roles CRUD + 校验 + agents 列表不含角色", async () => {
    const list = await import("@/app/api/roles/route");
    const one = await import("@/app/api/roles/[id]/route");
    const open = await import("@/app/api/roles/[id]/open/route");
    const agentsRoute = await import("@/app/api/agents/route");
    const agentOne = await import("@/app/api/agents/[id]/route");

    expect((await list.POST(json("POST", "{oops"))).status).toBe(400);
    expect((await list.POST(json("POST", { intro: "no name" }))).status).toBe(400);
    expect((await list.POST(json("POST", { name: "a", avatarHue: 400 }))).status).toBe(400);
    const created = await list.POST(json("POST", { name: "Api Role", avatarHue: 200 }));
    expect(created.status).toBe(201);
    const { role } = (await created.json()) as { role: { id: string; slug: string; homeDir: string } };
    expect(role.slug).toBe("api-role");

    const all = (await (await list.GET()).json()) as { roles: { id: string }[] };
    expect(all.roles.some((r) => r.id === role.id)).toBeTrue();

    const picker = (await (await agentsRoute.GET(new Request("http://localhost/api/agents?all=1"))).json()) as {
      agents: { id: string }[];
    };
    expect(picker.agents.some((a) => a.id === role.id)).toBeFalse();
    // /api/agents/[id] 不认角色
    expect((await agentOne.GET(json("GET"), params({ id: role.id }))).status).toBe(404);
    expect((await agentOne.DELETE(json("DELETE"), params({ id: role.id }))).status).toBe(404);
    // /api/agents POST 塞 kind:'role' 也只能建出普通 agent
    const sneaky = (await (await agentsRoute.POST(json("POST", { slug: "sneaky", name: "s", kind: "role" }))).json()) as {
      agent: { kind: string };
    };
    expect(sneaky.agent.kind).toBe("agent");

    const patched = await one.PATCH(json("PATCH", { intro: "改了" }), params({ id: role.id }));
    expect(((await patched.json()) as { role: { intro: string } }).role.intro).toBe("改了");
    expect((await one.PATCH(json("PATCH", { slug: "x" }), params({ id: role.id }))).status).toBe(400);
    expect((await one.PATCH(json("PATCH", { name: "x" }), params({ id: "missing" }))).status).toBe(404);
    expect((await one.GET(json("GET"), params({ id: "missing" }))).status).toBe(404);

    expect(await (await open.POST(json("POST"), params({ id: role.id }))).json()).toEqual({ sessionId: null });
    expect((await open.POST(json("POST"), params({ id: "missing" }))).status).toBe(404);

    expect((await one.DELETE(json("DELETE"), params({ id: role.id }))).status).toBe(200);
    expect((await one.GET(json("GET"), params({ id: role.id }))).status).toBe(404);
  });

  test("记忆路由：PUT / GET / DELETE，非法文件名 400", async () => {
    const list = await import("@/app/api/roles/route");
    const mems = await import("@/app/api/roles/[id]/memories/route");
    const memFile = await import("@/app/api/roles/[id]/memories/[file]/route");
    const userMd = await import("@/app/api/roles/[id]/user-md/route");
    const { role } = (await (await list.POST(json("POST", { name: "Mem Api" }))).json()) as { role: { id: string } };
    const body = { name: "n", description: "d", type: "user", body: "b" };

    const put = await memFile.PUT(json("PUT", body), params({ id: role.id, file: "n.md" }));
    expect(put.status).toBe(200);
    expect(((await put.json()) as { memory: { file: string } }).memory.file).toBe("n.md");
    for (const file of ["..%2Fx.md", "../x.md", "X.md", "n.txt"]) {
      expect((await memFile.PUT(json("PUT", body), params({ id: role.id, file }))).status).toBe(400);
    }
    expect((await memFile.PUT(json("PUT", { ...body, type: "bad" }), params({ id: role.id, file: "n.md" }))).status).toBe(400);
    expect((await userMd.PUT(json("PUT", { text: "hi" }), params({ id: role.id }))).status).toBe(200);

    const got = (await (await mems.GET(json("GET"), params({ id: role.id }))).json()) as {
      userMd: string;
      memories: { file: string }[];
    };
    expect(got.userMd).toBe("hi");
    expect(got.memories.map((m) => m.file)).toEqual(["n.md"]);

    expect((await memFile.DELETE(json("DELETE"), params({ id: role.id, file: "n.md" }))).status).toBe(200);
    expect((await memFile.DELETE(json("DELETE"), params({ id: role.id, file: "n.md" }))).status).toBe(404);
    expect((await mems.GET(json("GET"), params({ id: "missing" }))).status).toBe(404);
  });
});
