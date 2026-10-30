import { afterAll, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 从会话提炼（docs/roles-p2.md C）：来源列表、正文截断、模型输出解析（围栏 / 废话 / 尾逗号）、
// 解析失败重试一次。模型调用注入假 runner，不 spawn claude。

mock.module("server-only", () => ({}));

const testDir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "trellis-distill-")));
const prevDb = process.env.TRELLIS_DB_PATH;
const prevRoles = process.env.TRELLIS_ROLES_DIR;
process.env.TRELLIS_DB_PATH = path.join(testDir, "d.db");
process.env.TRELLIS_ROLES_DIR = path.join(testDir, "roles");

const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const repo = await import("./repo");
const distill = await import("./role-distill");
const { RoleError } = await import("./roles");

afterAll(() => {
  sqlite.resetDBForTests();
  if (prevDb === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = prevDb;
  if (prevRoles === undefined) delete process.env.TRELLIS_ROLES_DIR;
  else process.env.TRELLIS_ROLES_DIR = prevRoles;
  fs.rmSync(testDir, { recursive: true, force: true });
});

function seed(id: string, turns: [string, string][], opts: { kind?: string; updatedAt?: number; workspace?: string } = {}) {
  const db = sqlite.getDB();
  repo.createSessionWithRoot({
    sessionId: id,
    nodeId: `${id}-0`,
    title: `会话 ${id}`,
    question: turns[0][0],
    now: 1000,
    mode: opts.workspace ? "project" : "chat",
    workspacePath: opts.workspace ?? null,
    registerWorkspace: false,
  });
  db.prepare("UPDATE nodes SET status='done', response=? WHERE id=?").run(turns[0][1], `${id}-0`);
  let parent = `${id}-0`;
  turns.slice(1).forEach(([q, a], i) => {
    const nid = `${id}-${i + 1}`;
    repo.createBranchNode({ nodeId: nid, parentId: parent, question: q, parentAnchor: null, now: 1001 + i });
    db.prepare("UPDATE nodes SET status='done', response=? WHERE id=?").run(a, nid);
    parent = nid;
  });
  db.prepare("UPDATE sessions SET updated_at = ?, kind = ? WHERE id = ?").run(opts.updatedAt ?? 2000, opts.kind ?? "user", id);
}

const GOOD = {
  name: "老周",
  intro: "架构审稿人，先问边界再给方案",
  systemPrompt: "你是一位偏架构的审稿人。",
  memories: [
    { name: "hub-gateway-3200", description: "hub 走网关 3200", type: "project", body: "hub.home 走网关 3200 端口" },
    { name: "devbox 是 office", description: "devbox = office", type: "reference", body: "devbox 就是 office 那台" },
    { name: "坏类型", description: "", type: "weird", body: "类型不认识回落 project" },
    { name: "", description: "没名字的丢掉", type: "user", body: "x" },
  ],
};

describe("parseDistillOutput", () => {
  test("纯 JSON / ```json 围栏 / 前后废话 / 尾逗号都能解析；记忆文件名合法且去重", () => {
    const variants = [
      JSON.stringify(GOOD),
      "```json\n" + JSON.stringify(GOOD, null, 2) + "\n```",
      "好的，下面是草稿：\n" + JSON.stringify(GOOD) + "\n希望有帮助",
      JSON.stringify(GOOD).replace(/}]}$/, "},]}"),
    ];
    for (const v of variants) {
      const d = distill.parseDistillOutput(v)!;
      expect(d.name).toBe("老周");
      expect(d.intro).toBe(GOOD.intro);
      expect(d.memories.map((m) => m.file)).toEqual(["hub-gateway-3200.md", "devbox-office.md", "memory-3.md"]);
      expect(d.memories.map((m) => m.type)).toEqual(["project", "reference", "project"]);
      for (const m of d.memories) expect(m.file).toMatch(/^[a-z0-9][a-z0-9._-]{0,80}\.md$/);
    }
  });

  test("缺 name / systemPrompt、不是对象、坏 JSON → null", () => {
    expect(distill.parseDistillOutput("")).toBeNull();
    expect(distill.parseDistillOutput("没有 JSON")).toBeNull();
    expect(distill.parseDistillOutput("[1,2]")).toBeNull();
    expect(distill.parseDistillOutput('{"name":"x"}')).toBeNull();
    expect(distill.parseDistillOutput('{"name": "x", "systemPrompt": ')).toBeNull();
  });

  test("记忆名撞车 → -2 后缀；最多 12 条", () => {
    const many = { ...GOOD, memories: Array.from({ length: 20 }, () => ({ name: "same", type: "user", body: "b" })) };
    const d = distill.parseDistillOutput(JSON.stringify(many))!;
    expect(d.memories.length).toBe(12);
    expect(d.memories.slice(0, 3).map((m) => m.file)).toEqual(["same.md", "same-2.md", "same-3.md"]);
  });
});

describe("来源与正文", () => {
  test("listDistillSources：只列 kind=user、未归档、有已完成回答的，按最近更新，可按标题搜", () => {
    seed("a", [["q1", "a1"], ["q2", "a2"]], { updatedAt: 3000, workspace: testDir });
    seed("b", [["q", "a"]], { updatedAt: 4000 });
    seed("t", [["q", "a"]], { kind: "task", updatedAt: 5000 });
    seed("r", [["q", "a"]], { kind: "role", updatedAt: 6000 });
    const list = distill.listDistillSources();
    expect(list.map((s) => s.sessionId)).toEqual(["b", "a"]);
    expect(list[1]).toMatchObject({ title: "会话 a", nodeCount: 2, workspace: path.basename(testDir) });
    expect(distill.listDistillSources("会话 a").map((s) => s.sessionId)).toEqual(["a"]);
    expect(distill.listDistillSources("100%_").length).toBe(0);
  });

  test("buildDistillTranscript：从最近往前取满预算，标记截断", () => {
    const turns: [string, string][] = Array.from({ length: 30 }, (_, i) => [`问${i}`, `答${i} ` + "字".repeat(500)]);
    seed("long", turns);
    const full = distill.buildDistillTranscript("long");
    expect(full.truncated).toBe(false);
    expect(full.nodeCount).toBe(30);
    const cut = distill.buildDistillTranscript("long", 3000);
    expect(cut.truncated).toBe(true);
    expect(cut.text.length).toBeLessThanOrEqual(3200);
    expect(cut.text).toContain("问29");
    expect(cut.text).not.toContain("问0\n");
    expect(() => distill.buildDistillTranscript("nope")).toThrow(RoleError);
  });
});

describe("distillRole", () => {
  test("第一次输出坏了 → 带提示重试一次成功；两次都坏 → 502", async () => {
    seed("src", [["帮我审一下 hub 架构", "先说边界：hub 走网关 3200……"]]);
    const prompts: string[] = [];
    const flaky = async (_sys: string, p: string) => {
      prompts.push(p);
      return prompts.length === 1 ? "抱歉我先想想" : JSON.stringify(GOOD);
    };
    const d = await distill.distillRole("src", flaky);
    expect(prompts.length).toBe(2);
    expect(prompts[0]).toContain("帮我审一下 hub 架构");
    expect(prompts[1]).toContain("不是合法 JSON");
    expect(d.source).toEqual({ sessionId: "src", title: "会话 src", nodeCount: 1, truncated: false });
    expect(d.memories.length).toBe(3);

    let calls = 0;
    const bad = async () => {
      calls++;
      return null;
    };
    let err: unknown = null;
    try {
      await distill.distillRole("src", bad);
    } catch (e) {
      err = e;
    }
    expect(calls).toBe(2);
    expect((err as InstanceType<typeof RoleError>).status).toBe(502);
  });
});
