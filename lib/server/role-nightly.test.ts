import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 角色 P2 · A 包后端（docs/roles-p2.md）：提案解析、系统节点、夜间整理的跳过 / 调度、
// 接受 / 撤销（逐种）、路径安全、例行落进固定会话、后台任务登记、能力。
// 临时 DB + 临时 TRELLIS_ROLES_DIR，不碰真 HOME；模型调用一律换成假 runner。

mock.module("server-only", () => ({}));
// 调度 tick 每小时 :07 顺带查授权（会 spawn CLI）：换成空函数。磁盘水位只是 statfs，不 mock
// （mock 进程内共享，会漏给 disk-watch.test.ts）。
// 导出名与 butler.test.ts 的同名 mock 取并集：bun 的 mock 进程内共享、只能原地改已有导出名。
mock.module("./auth-health", () => ({ checkAuthAlerts: async () => {}, getAuthHealth: async () => null }));

const testDir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "trellis-roles-p2a-")));
const prevDb = process.env.TRELLIS_DB_PATH;
const prevRoles = process.env.TRELLIS_ROLES_DIR;
process.env.TRELLIS_DB_PATH = path.join(testDir, "p2a.db");
process.env.TRELLIS_ROLES_DIR = path.join(testDir, "roles");

const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const roles = await import("./roles");
const repo = await import("./repo");
const agents = await import("./agents");
const changes = await import("./role-changes");
const nightly = await import("./role-nightly");
const routines = await import("./role-routines");
const systemNode = await import("./system-node");
const tasks = await import("./tasks");
const scheduler = await import("./task-scheduler");
const { latestNightlySlot, ROLE_CHANGE_REVERT_MS } = await import("@/lib/role-changes");
const { routineCron, describeRoutineCron } = await import("@/lib/role-routines");

afterAll(() => {
  nightly.setNightlyRunnerForTests(null);
  sqlite.resetDBForTests();
  if (prevDb === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = prevDb;
  if (prevRoles === undefined) delete process.env.TRELLIS_ROLES_DIR;
  else process.env.TRELLIS_ROLES_DIR = prevRoles;
  fs.rmSync(testDir, { recursive: true, force: true });
});

const db = () => sqlite.getDB();

/** 建一个有固定会话的角色（会话里一轮已完成的问答）。 */
let seq = 0;
function roleWithHome(opts: { done?: boolean; at?: number } = {}) {
  seq++;
  const r = roles.createRole({ name: `P2A Role ${seq}`, systemPrompt: "冷静、讲证据" });
  const sid = `p2a-s-${seq}`;
  const nid = `p2a-n-${seq}`;
  repo.createSessionWithRoot({
    sessionId: sid,
    nodeId: nid,
    title: "t",
    question: "以后报告都用表格",
    now: opts.at ?? Date.now(),
    mode: "project",
    workspacePath: r.homeDir,
    agentId: r.id,
    registerWorkspace: false,
  });
  roles.adoptRoleHomeSession(r.id, sid);
  if (opts.done !== false) {
    db().prepare("UPDATE nodes SET status = 'done', response = '好的，记下了' WHERE id = ?").run(nid);
  }
  return { role: roles.getRole(r.id)!, sessionId: sid, nodeId: nid };
}

function writeMemory(roleId: string, file: string, name: string, body = "正文") {
  roles.writeRoleMemory(roleId, file, { name, description: `${name} 的说明`, type: "feedback", body });
}

const ctxOf = (homeDir: string) => changes.proposalContext(homeDir);

// ---------------------------------------------------------------------------

describe("提案解析", () => {
  const ctx = {
    memories: new Map([
      ["a.md", "A"],
      ["b.md", "B"],
      ["c.md", "C"],
    ]),
    skills: new Set<string>(),
  };

  test("没有 JSON → ok=false", () => {
    const p = changes.parseNightlyProposal("今天没什么好整理的。", ctx);
    expect(p.ok).toBeFalse();
    expect(p.changes).toEqual([]);
  });

  test("坏 JSON（截断）→ ok=false，不抛", () => {
    const p = changes.parseNightlyProposal('{"summary":"x","changes":[{"kind":"add",', ctx);
    expect(p.ok).toBeFalse();
  });

  test("围栏 + 前后废话都能抠出来", () => {
    const text = [
      "好的，下面是提案：",
      "```json",
      JSON.stringify({ summary: "读了 2 轮", changes: [{ kind: "delete", file: "a.md", reason: "过期" }] }),
      "```",
      "以上。",
    ].join("\n");
    const p = changes.parseNightlyProposal(text, ctx);
    expect(p.ok).toBeTrue();
    expect(p.summary).toBe("读了 2 轮");
    expect(p.changes).toEqual([{ kind: "delete", file: "a.md", name: "A", reason: "过期" }]);
  });

  test("无围栏、正文里夹着带花括号的字符串也能配平", () => {
    const obj = { changes: [{ kind: "add", memory: { name: "用 {} 包变量", body: "x } y { z", type: "user" } }] };
    const p = changes.parseNightlyProposal(`前言 ${JSON.stringify(obj)} 后记`, ctx);
    expect(p.changes).toHaveLength(1);
    expect(p.changes[0]).toMatchObject({ kind: "add", memory: { name: "用 {} 包变量", type: "user" } });
  });

  test("顶层直接是数组、add 字段平铺也认", () => {
    const p = changes.parseNightlyProposal(
      JSON.stringify([{ kind: "add", name: "Prefers Tables", body: "报告用表格", type: "feedback" }]),
      ctx,
    );
    expect(p.changes).toHaveLength(1);
    const c = p.changes[0] as Extract<(typeof p.changes)[number], { kind: "add" }>;
    expect(c.memory.file).toBe("prefers-tables.md");
  });

  test("部分坏：坏的丢掉、好的留下，dropped 计数", () => {
    const p = changes.parseNightlyProposal(
      JSON.stringify({
        changes: [
          { kind: "add", memory: { name: "ok", body: "fine", file: "ok.md" } },
          { kind: "add", memory: { name: "穿越", body: "x", file: "../../etc/passwd" } },
          { kind: "delete", file: "nope.md" },
          { kind: "merge", files: ["a.md"], into: { name: "x", body: "y" } },
          { kind: "merge", files: ["a.md", "zzz.md"], into: { name: "x", body: "y" } },
          { kind: "skill", name: "Bad Name", body: "x" },
          { kind: "rename", file: "a.md" },
          "not an object",
          { kind: "skill", name: "review-diff", description: "审 diff", body: "1. 先类型检查" },
        ],
      }),
      ctx,
    );
    expect(p.ok).toBeTrue();
    expect(p.changes.map((c) => c.kind)).toEqual(["add", "skill"]);
    expect(p.dropped).toBe(7);
  });

  test("add 撞上现有文件名自动换名，不覆盖", () => {
    const p = changes.parseNightlyProposal(
      JSON.stringify({ changes: [{ kind: "add", memory: { name: "A again", file: "a.md", body: "x" } }] }),
      ctx,
    );
    const c = p.changes[0] as Extract<(typeof p.changes)[number], { kind: "add" }>;
    expect(c.memory.file).not.toBe("a.md");
    expect(c.memory.file).toMatch(/^a-\d+\.md$/);
  });

  test("同一个文件只许被一条提案碰", () => {
    const p = changes.parseNightlyProposal(
      JSON.stringify({
        changes: [
          { kind: "merge", files: ["a.md", "b.md"], into: { name: "AB", body: "合并" } },
          { kind: "delete", file: "b.md" },
          { kind: "delete", file: "c.md" },
        ],
      }),
      ctx,
    );
    expect(p.changes.map((c) => c.kind)).toEqual(["merge", "delete"]);
    expect((p.changes[1] as { file: string }).file).toBe("c.md");
  });

  test("merge 的 into 指向第三条现有记忆 → 丢掉（会覆盖别人）", () => {
    const p = changes.parseNightlyProposal(
      JSON.stringify({ changes: [{ kind: "merge", files: ["a.md", "b.md"], into: { file: "c.md", name: "x", body: "y" } }] }),
      ctx,
    );
    expect(p.changes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("appendSystemNode", () => {
  test("建一个已完成的新根，meta 带 kind，不动 root_node_id、不进搜索", () => {
    const { sessionId, nodeId } = roleWithHome();
    const before = repo.getSession(sessionId)!;
    const { nodeId: sys } = systemNode.appendSystemNode({
      sessionId,
      title: "夜间整理",
      body: "- 新增：x",
      kind: "role-nightly",
      meta: { roleId: "r", kind: "group-round-end" },
    });
    const n = repo.getNode(sys)!;
    expect(n.status).toBe("done");
    expect(n.parentId).toBeNull();
    expect(n.question).toBe("夜间整理");
    expect(n.response).toBe("- 新增：x");
    // meta 里误带的 kind 不能把类型改掉
    expect(n.meta).toEqual({ roleId: "r", kind: "role-nightly" });
    expect(repo.getSession(sessionId)!.rootNodeId).toBe(before.rootNodeId);
    expect(systemNode.isSystemNodeId(sys)).toBeTrue();
    expect(systemNode.isSystemNodeId(nodeId)).toBeFalse();
    expect(repo.getNode(nodeId)!.meta).toBeNull();
    // 同一列也装群聊消息标记（group-user / group-reply）：带 meta 不等于系统节点
    db().prepare("UPDATE nodes SET meta_json = ? WHERE id = ?").run(JSON.stringify({ kind: "group-user" }), nodeId);
    expect(repo.getNode(nodeId)!.meta).toEqual({ kind: "group-user" });
    expect(systemNode.isSystemNodeId(nodeId)).toBeFalse();
    db().prepare("UPDATE nodes SET meta_json = NULL WHERE id = ?").run(nodeId);
    const hits = db().query("SELECT COUNT(*) AS n FROM search_index WHERE source_id = ?").get(sys) as { n: number };
    expect(hits.n).toBe(0);
  });

  test("不破坏 resume：系统节点之后接着真实节点问，resume 的仍是原 CLI 会话", () => {
    const { sessionId, nodeId } = roleWithHome();
    repo.setRootResumeIdForNode(nodeId, "claude", "cli-session-1");
    const { nodeId: sys } = systemNode.appendSystemNode({ sessionId, title: "夜间整理", body: "", kind: "role-nightly" });
    // 系统节点自己没有可接的 CLI 会话
    expect(repo.getRootResumeIdForNode(sys, "claude")).toBeNull();
    // 下一轮用户消息接在上一个真实节点后面（前端 tipNode 跳过系统节点）
    repo.createBranchNode({ nodeId: "p2a-next", parentId: nodeId, question: "继续", parentAnchor: null, now: Date.now() });
    expect(repo.getRootResumeIdForNode("p2a-next", "claude")).toBe("cli-session-1");
  });

  test("会话不存在 → 抛错", () => {
    expect(() =>
      systemNode.appendSystemNode({ sessionId: "nope", title: "x", body: "", kind: "role-follow" }),
    ).toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------

describe("夜间整理：跳过与提案", () => {
  let calls = 0;
  let output = "";
  beforeEach(() => {
    calls = 0;
    nightly.setNightlyRunnerForTests(async () => {
      calls++;
      return output;
    });
  });

  test("没有新对话 → skipped，不调模型", async () => {
    const { role } = roleWithHome({ done: false }); // 唯一一轮还在 streaming
    const r = await nightly.runRoleNightly(role.id);
    expect(r).toEqual({ status: "skipped", reason: "没有新对话" });
    expect(calls).toBe(0);
    expect(nightly.getNightlyState(role.id).lastStatus).toBe("skipped");
  });

  test("没有固定会话 / 记忆关 → skipped，不调模型", async () => {
    const bare = roles.createRole({ name: "No Home Yet" });
    expect((await nightly.runRoleNightly(bare.id)).status).toBe("skipped");
    const { role } = roleWithHome();
    roles.updateRole(role.id, { memoryEnabled: false });
    expect(await nightly.runRoleNightly(role.id)).toEqual({ status: "skipped", reason: "记忆已关" });
    expect(calls).toBe(0);
  });

  test("有新对话 → 调模型、插整理卡、写 pending 提案、推进游标；再跑一次就跳过", async () => {
    const { role, sessionId, nodeId } = roleWithHome();
    writeMemory(role.id, "old.md", "旧的");
    output = JSON.stringify({
      summary: "读了 1 轮",
      changes: [
        { kind: "add", reason: "用户说的", memory: { name: "报告用表格", file: "tables.md", type: "feedback", body: "报告用表格" } },
        { kind: "delete", file: "old.md", reason: "过期" },
      ],
    });
    let seenPrompt = "";
    let seenSystem = "";
    nightly.setNightlyRunnerForTests(async (a) => {
      calls++;
      seenPrompt = a.prompt;
      seenSystem = a.systemPrompt;
      return output;
    });
    const r = await nightly.runRoleNightly(role.id);
    expect(r.status).toBe("ran");
    expect(calls).toBe(1);
    expect(seenPrompt).toContain("以后报告都用表格");
    expect(seenPrompt).toContain("memories/old.md");
    expect(seenSystem).toContain("冷静、讲证据");
    expect(seenSystem).toContain("只输出");
    if (r.status !== "ran") throw new Error("unreachable");
    const card = repo.getNode(r.nodeId)!;
    expect(card.sessionId).toBe(sessionId);
    expect(card.meta?.kind).toBe("role-nightly");
    expect(card.meta?.read).toBe(1);
    const list = changes.listRoleChanges(role.id, { nodeId: r.nodeId });
    expect(list.map((c) => [c.kind, c.status])).toEqual([
      ["add", "pending"],
      ["delete", "pending"],
    ]);
    // 文件还没动（只是提案）
    expect(fs.existsSync(path.join(role.homeDir, "memories", "tables.md"))).toBeFalse();
    expect(fs.existsSync(path.join(role.homeDir, "memories", "old.md"))).toBeTrue();
    const st = nightly.getNightlyState(role.id);
    expect(st.cursorAt).toBe(repo.getNode(nodeId)!.createdAt);
    expect(st.pendingNodes).toBe(0);
    // 系统节点本身不算「新对话」
    expect(await nightly.runRoleNightly(role.id)).toEqual({ status: "skipped", reason: "没有新对话" });
    expect(calls).toBe(1);
  });

  test("模型没给 JSON → error，游标不动，不插卡", async () => {
    const { role, sessionId } = roleWithHome();
    output = "我觉得都挺好的。";
    const r = await nightly.runRoleNightly(role.id);
    expect(r.status).toBe("error");
    expect(nightly.getNightlyState(role.id).cursorAt).toBeNull();
    expect(repo.getSessionNodes(sessionId).some((n) => n.meta)).toBeFalse();
  });

  test("空提案 → empty，推进游标，不出声", async () => {
    const { role, sessionId } = roleWithHome();
    output = '{"summary":"没什么","changes":[]}';
    expect((await nightly.runRoleNightly(role.id)).status).toBe("empty");
    expect(nightly.getNightlyState(role.id).cursorAt).not.toBeNull();
    expect(repo.getSessionNodes(sessionId).some((n) => n.meta)).toBeFalse();
  });

  test("模型抛错 → error 状态、running 复位", async () => {
    const { role } = roleWithHome();
    nightly.setNightlyRunnerForTests(async () => {
      throw new Error("claude 退出码 1");
    });
    const r = await nightly.runRoleNightly(role.id);
    expect(r).toEqual({ status: "error", error: "claude 退出码 1" });
    const st = nightly.getNightlyState(role.id);
    expect(st.running).toBeFalse();
    expect(st.lastError).toContain("退出码");
  });

  test("同一角色并发两次：第二次 busy", async () => {
    const { role } = roleWithHome();
    let release: (v: string) => void = () => {};
    nightly.setNightlyRunnerForTests(() => new Promise((res) => (release = res)));
    const first = nightly.runRoleNightly(role.id);
    await Bun.sleep(5);
    expect(await nightly.runRoleNightly(role.id)).toEqual({ status: "busy" });
    release('{"changes":[]}');
    expect((await first).status).toBe("empty");
  });

  test("频率：默认 daily，可改 weekly / off，非法值 400", () => {
    const { role } = roleWithHome();
    expect(nightly.getNightlyState(role.id).frequency).toBe("daily");
    expect(nightly.setNightlyFrequency(role.id, "weekly").frequency).toBe("weekly");
    expect(nightly.setNightlyFrequency(role.id, "off").frequency).toBe("off");
    expect(() => nightly.setNightlyFrequency(role.id, "hourly")).toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("调度", () => {
  test("latestNightlySlot：每天 / 每周一 03:30", () => {
    const at = (s: string) => new Date(s);
    const d = latestNightlySlot("daily", at("2026-10-30T03:31:00"))!;
    expect(new Date(d).toString()).toBe(at("2026-10-30T03:30:00").toString());
    const before = latestNightlySlot("daily", at("2026-10-30T03:29:00"))!;
    expect(new Date(before).getDate()).toBe(29);
    // 2026-10-30 是周五 → 最近的周一是 10-26
    const w = latestNightlySlot("weekly", at("2026-10-30T12:00:00"))!;
    expect(new Date(w).getDay()).toBe(1);
    expect(new Date(w).getDate()).toBe(26);
    expect(latestNightlySlot("off", at("2026-10-30T12:00:00"))).toBeNull();
  });

  test("tickRoleNightly：槽内只跑一次；超过 6h 不补；off 不跑", async () => {
    let calls = 0;
    nightly.setNightlyRunnerForTests(async () => {
      calls++;
      return '{"changes":[]}';
    });
    // 别的测试留下的角色先关掉，这里只看新建的两个
    for (const r of roles.listRoles()) nightly.setNightlyFrequency(r.id, "off");
    const a = roleWithHome().role;
    const b = roleWithHome().role;
    nightly.setNightlyFrequency(a.id, "daily");
    nightly.setNightlyFrequency(b.id, "off");
    const now = new Date();
    now.setHours(3, 31, 0, 0);
    expect(await nightly.tickRoleNightly(now)).toEqual([a.id]);
    expect(calls).toBe(1);
    // 同一槽第二次 tick 抢不到
    expect(await nightly.tickRoleNightly(new Date(now.getTime() + 60_000))).toEqual([]);
    // 新的一天、但离槽 7h：不补跑
    const late = new Date(now.getTime() + 24 * 3600_000 + 7 * 3600_000);
    expect(await nightly.tickRoleNightly(late)).toEqual([]);
    // 新的一天、离槽 2h：补跑（catch-up）
    const catchup = new Date(now.getTime() + 2 * 24 * 3600_000 + 2 * 3600_000);
    expect(await nightly.tickRoleNightly(catchup)).toEqual([a.id]);
    expect(calls).toBe(1); // 第二次没新对话 → skipped，不调模型
    expect(nightly.getNightlyState(a.id).lastStatus).toBe("skipped");
  });

  test("调度器 tick 调到了夜间整理", async () => {
    for (const r of roles.listRoles()) nightly.setNightlyFrequency(r.id, "off");
    const { role } = roleWithHome();
    nightly.setNightlyFrequency(role.id, "daily");
    // 把这个角色的上一个槽挪到很久以前，让「当前槽」可抢；时间落在补跑窗口内由下面的 slot 决定
    const slot = latestNightlySlot("daily", new Date())!;
    let ran = false;
    nightly.setNightlyRunnerForTests(async () => {
      ran = true;
      return '{"changes":[]}';
    });
    await scheduler.runSchedulerTickForTests();
    await Bun.sleep(50);
    const st = db().query("SELECT last_slot FROM role_nightly WHERE role_id = ?").get(role.id) as
      | { last_slot: number | null }
      | null;
    if (Date.now() - slot <= 6 * 3600_000) {
      expect(st?.last_slot).toBe(slot);
      expect(ran).toBeTrue();
    } else {
      // 不在窗口内：tick 照样走到了（建了状态行或没建），但不抢槽
      expect(st?.last_slot ?? null).toBeNull();
      expect(ran).toBeFalse();
    }
  });
});

// ---------------------------------------------------------------------------

describe("接受 / 拒绝 / 撤销", () => {
  function propose(roleId: string, payloads: Parameters<typeof changes.insertRoleChanges>[2]) {
    return changes.insertRoleChanges(roleId, null, payloads);
  }

  test("add：接受写文件 + 重建索引；撤销删掉", () => {
    const { role } = roleWithHome();
    const [id] = propose(role.id, [
      { kind: "add", reason: "r", memory: { file: "tables.md", name: "报告用表格", description: "d", type: "feedback", body: "用表格" } },
    ]);
    const c = changes.acceptRoleChange(role.id, id);
    expect(c.status).toBe("applied");
    expect(c.revertible).toBeTrue();
    const p = path.join(role.homeDir, "memories", "tables.md");
    expect(fs.readFileSync(p, "utf8")).toContain("用表格");
    expect(fs.readFileSync(path.join(role.homeDir, "MEMORY.md"), "utf8")).toContain("memories/tables.md");
    expect(changes.revertRoleChange(role.id, id).status).toBe("reverted");
    expect(fs.existsSync(p)).toBeFalse();
    expect(fs.readFileSync(path.join(role.homeDir, "MEMORY.md"), "utf8")).not.toContain("tables.md");
  });

  test("merge：两条合成一条；撤销恢复原样", () => {
    const { role } = roleWithHome();
    writeMemory(role.id, "a.md", "先跑类型检查", "A body");
    writeMemory(role.id, "b.md", "改完跑测试", "B body");
    const aBefore = fs.readFileSync(path.join(role.homeDir, "memories", "a.md"), "utf8");
    const [id] = propose(role.id, [
      {
        kind: "merge",
        files: ["a.md", "b.md"],
        into: { file: "a.md", name: "先类型检查再跑测试", description: "", type: "feedback", body: "合并" },
        reason: "一回事",
      },
    ]);
    expect(changes.acceptRoleChange(role.id, id).status).toBe("applied");
    expect(fs.readFileSync(path.join(role.homeDir, "memories", "a.md"), "utf8")).toContain("合并");
    expect(fs.existsSync(path.join(role.homeDir, "memories", "b.md"))).toBeFalse();
    changes.revertRoleChange(role.id, id);
    expect(fs.readFileSync(path.join(role.homeDir, "memories", "a.md"), "utf8")).toBe(aBefore);
    expect(fs.readFileSync(path.join(role.homeDir, "memories", "b.md"), "utf8")).toContain("B body");
    expect(fs.readFileSync(path.join(role.homeDir, "MEMORY.md"), "utf8")).toContain("memories/b.md");
  });

  test("delete：删文件；撤销写回", () => {
    const { role } = roleWithHome();
    writeMemory(role.id, "stale.md", "hub 还没上公网");
    const [id] = propose(role.id, [{ kind: "delete", file: "stale.md", name: "hub 还没上公网", reason: "过期" }]);
    changes.acceptRoleChange(role.id, id);
    expect(fs.existsSync(path.join(role.homeDir, "memories", "stale.md"))).toBeFalse();
    changes.revertRoleChange(role.id, id);
    expect(fs.readFileSync(path.join(role.homeDir, "memories", "stale.md"), "utf8")).toContain("hub 还没上公网");
  });

  test("skill：写 skills/<name>/SKILL.md + .claude/skills 软链；白名单补 Skill；撤销删目录", () => {
    const { role } = roleWithHome();
    routines.updateRoleCapabilities(role.id, { tools: ["Read", "Grep"] });
    const [id] = propose(role.id, [
      { kind: "skill", name: "review-diff", description: "审 diff 的套路", body: "1. 先类型检查\n2. 只报能复现的", reason: "用了 3 次" },
    ]);
    expect(changes.acceptRoleChange(role.id, id).status).toBe("applied");
    const skill = path.join(role.homeDir, "skills", "review-diff", "SKILL.md");
    const text = fs.readFileSync(skill, "utf8");
    expect(text).toStartWith("---\nname: review-diff\ndescription: \"审 diff 的套路\"\n---");
    expect(text).toContain("只报能复现的");
    const link = path.join(role.homeDir, ".claude", "skills");
    expect(fs.lstatSync(link).isSymbolicLink()).toBeTrue();
    expect(fs.readlinkSync(link)).toBe("../skills");
    expect(fs.existsSync(path.join(link, "review-diff", "SKILL.md"))).toBeTrue();
    expect(routines.getRoleCapabilities(role.id).tools).toEqual(["Read", "Grep", "Skill"]);
    expect(routines.getRoleCapabilities(role.id).roleSkills.map((s) => s.name)).toEqual(["review-diff"]);
    changes.revertRoleChange(role.id, id);
    expect(fs.existsSync(path.join(role.homeDir, "skills", "review-diff"))).toBeFalse();
  });

  test("拒绝：不动文件；已决定的不能再接受", () => {
    const { role } = roleWithHome();
    const [id] = propose(role.id, [
      { kind: "add", reason: "", memory: { file: "nope.md", name: "n", description: "", type: "user", body: "b" } },
    ]);
    expect(changes.rejectRoleChange(role.id, id).status).toBe("rejected");
    expect(fs.existsSync(path.join(role.homeDir, "memories", "nope.md"))).toBeFalse();
    expect(() => changes.acceptRoleChange(role.id, id)).toThrow(/rejected/);
  });

  test("前提失效 → failed 带原因（要删的文件已经没了）", () => {
    const { role } = roleWithHome();
    const [id] = propose(role.id, [{ kind: "delete", file: "ghost.md", name: "ghost", reason: "" }]);
    const c = changes.acceptRoleChange(role.id, id);
    expect(c.status).toBe("failed");
    expect(c.error).toContain("不在了");
  });

  test("撤销：接受后文件又被改过 → 拒绝撤销；超过 7 天 → 拒绝撤销", () => {
    const { role } = roleWithHome();
    const [a, b] = propose(role.id, [
      { kind: "add", reason: "", memory: { file: "x.md", name: "x", description: "", type: "user", body: "x" } },
      { kind: "add", reason: "", memory: { file: "y.md", name: "y", description: "", type: "user", body: "y" } },
    ]);
    changes.acceptRoleChange(role.id, a);
    changes.acceptRoleChange(role.id, b);
    writeMemory(role.id, "x.md", "x 被用户改了");
    expect(() => changes.revertRoleChange(role.id, a)).toThrow(/又被改过/);
    db().prepare("UPDATE role_changes SET decided_at = ? WHERE id = ?").run(Date.now() - ROLE_CHANGE_REVERT_MS - 1000, b);
    expect(changes.getRoleChange(b)!.revertible).toBeFalse();
    expect(() => changes.revertRoleChange(role.id, b)).toThrow(/7 天/);
  });

  test("全部接受：按顺序逐条，已拒绝的不碰", () => {
    const { role } = roleWithHome();
    const ids = changes.insertRoleChanges(role.id, "card-1", [
      { kind: "add", reason: "", memory: { file: "p.md", name: "p", description: "", type: "user", body: "p" } },
      { kind: "add", reason: "", memory: { file: "q.md", name: "q", description: "", type: "user", body: "q" } },
    ]);
    changes.rejectRoleChange(role.id, ids[1]);
    const after = changes.acceptAllRoleChanges(role.id, "card-1");
    expect(after.map((c) => c.status)).toEqual(["applied", "rejected"]);
  });

  test("别的角色的改动 → 404", () => {
    const one = roleWithHome().role;
    const two = roleWithHome().role;
    const [id] = propose(one.id, [{ kind: "delete", file: "z.md", name: "z", reason: "" }]);
    expect(() => changes.acceptRoleChange(two.id, id)).toThrow(/没有这条改动/);
  });
});

describe("路径安全", () => {
  test("DB 里被篡改成穿越路径的提案：接受失败，角色目录外不落文件", () => {
    const { role } = roleWithHome();
    const [id] = changes.insertRoleChanges(role.id, null, [
      { kind: "add", reason: "", memory: { file: "ok.md", name: "n", description: "", type: "user", body: "b" } },
    ]);
    const evil = { kind: "add", reason: "", memory: { file: "../../escape.md", name: "n", description: "", type: "user", body: "b" } };
    db().prepare("UPDATE role_changes SET payload_json = ? WHERE id = ?").run(JSON.stringify(evil), id);
    const c = changes.acceptRoleChange(role.id, id);
    expect(c.status).toBe("failed");
    expect(fs.existsSync(path.join(role.homeDir, "..", "escape.md"))).toBeFalse();
    expect(fs.existsSync(path.join(path.dirname(path.dirname(role.homeDir)), "escape.md"))).toBeFalse();
  });

  test("skills/<name> 是指向目录外的软链 → 拒绝写入", () => {
    const { role } = roleWithHome();
    const outside = fs.mkdtempSync(path.join(testDir, "outside-"));
    fs.mkdirSync(path.join(role.homeDir, "skills"), { recursive: true });
    fs.symlinkSync(outside, path.join(role.homeDir, "skills", "sneaky"), "dir");
    const [id] = changes.insertRoleChanges(role.id, null, [
      { kind: "skill", name: "sneaky", description: "", body: "x", reason: "" },
    ]);
    expect(changes.acceptRoleChange(role.id, id).status).toBe("failed");
    expect(fs.existsSync(path.join(outside, "SKILL.md"))).toBeFalse();
  });

  test("删技能：非法名 400，软链拒绝", () => {
    const { role } = roleWithHome();
    expect(() => routines.deleteRoleSkill(role.id, "../x")).toThrow();
    const outside = fs.mkdtempSync(path.join(testDir, "outside2-"));
    fs.mkdirSync(path.join(role.homeDir, "skills"), { recursive: true });
    fs.symlinkSync(outside, path.join(role.homeDir, "skills", "linked"), "dir");
    expect(() => routines.deleteRoleSkill(role.id, "linked")).toThrow(/软链/);
    expect(fs.existsSync(outside)).toBeTrue();
  });
});

// ---------------------------------------------------------------------------

describe("例行", () => {
  test("routineCron / describeRoutineCron", () => {
    expect(routineCron({ kind: "daily", time: "09:00" })).toBe("0 9 * * *");
    expect(routineCron({ kind: "weekdays", time: "9:05" })).toBe("5 9 * * 1-5");
    expect(routineCron({ kind: "weekly", day: 1, time: "18:30" })).toBe("30 18 * * 1");
    expect(routineCron({ kind: "daily", time: "25:00" })).toBeNull();
    expect(describeRoutineCron("5 9 * * 1-5")).toBe("工作日 09:05");
    expect(describeRoutineCron("30 18 * * 1")).toBe("每周一 18:30");
    expect(describeRoutineCron("*/5 * * * *")).toBe("cron */5 * * * *");
  });

  test("新建：tasks 行 agent_id = 角色 + cron 触发器 + 静默标记；非法输入 400", () => {
    const { role } = roleWithHome();
    const r = routines.createRoleRoutine(role.id, {
      name: "巡检新合并的 PR",
      prompt: "看看今天合进 main 的 PR 有没有能复现的回归",
      trigger: { kind: "weekdays", time: "09:00" },
      quiet: true,
    });
    expect(r.cron).toBe("0 9 * * 1-5");
    expect(r.quiet).toBeTrue();
    const t = tasks.getTask(r.taskId)!;
    expect(t.agentId).toBe(role.id);
    expect(t.contextMode).toBe("project");
    expect(t.homeSessionId).toBeNull();
    expect(routines.listRoleRoutines(role.id).map((x) => x.taskId)).toEqual([r.taskId]);
    expect(() => routines.createRoleRoutine(role.id, { name: "", prompt: "x", trigger: { kind: "daily", time: "09:00" } })).toThrow();
    expect(() => routines.createRoleRoutine(role.id, { name: "x", prompt: "x", trigger: { kind: "cron", expr: "nope" } })).toThrow();
    // 开关
    expect(routines.updateRoleRoutine(role.id, r.taskId, { enabled: false }).enabled).toBeFalse();
    expect(routines.updateRoleRoutine(role.id, r.taskId, { trigger: { kind: "daily", time: "07:15" } }).cron).toBe("15 7 * * *");
  });

  test("执行落进角色固定会话（不建 task home 会话），用角色的工作目录", async () => {
    const { role, sessionId } = roleWithHome();
    const r = routines.createRoleRoutine(role.id, {
      name: "日报",
      prompt: "hello",
      trigger: { kind: "daily", time: "09:00" },
      quiet: true,
    });
    db().prepare("UPDATE tasks SET provider_id = 'mock', workspace_path = '/definitely/not/here' WHERE id = ?").run(r.taskId);
    const res = tasks.startTaskRun({ taskId: r.taskId });
    expect(res.ok).toBeTrue();
    if (!res.ok) throw new Error(res.reason);
    expect(res.sessionId).toBe(sessionId);
    const node = repo.getNode(res.nodeId)!;
    expect(node.parentId).toBeNull();
    // 静默约定追加在问题后面
    expect(node.question).toContain("[SILENT]");
    expect(tasks.getTask(r.taskId)!.homeSessionId).toBeNull();
    expect(repo.getSession(sessionId)!.kind).toBe("role");
    // 等 mock 跑完
    for (let i = 0; i < 200 && tasks.getRun(res.runId)!.status === "running"; i++) await Bun.sleep(50);
    expect(tasks.getRun(res.runId)!.status).toBe("done");
  });

  test("角色还没有固定会话：建一条并认作固定会话", async () => {
    const r0 = roles.createRole({ name: "Fresh Routine Role" });
    const r = routines.createRoleRoutine(r0.id, { name: "x", prompt: "hi", trigger: { kind: "daily", time: "08:00" } });
    db().prepare("UPDATE tasks SET provider_id = 'mock' WHERE id = ?").run(r.taskId);
    const res = tasks.startTaskRun({ taskId: r.taskId });
    if (!res.ok) throw new Error(res.reason);
    expect(roles.getRole(r0.id)!.homeSessionId).toBe(res.sessionId);
    expect(repo.getSession(res.sessionId)!.kind).toBe("role");
    expect(repo.getSession(res.sessionId)!.workspacePath).toBe(r0.homeDir);
    for (let i = 0; i < 200 && tasks.getRun(res.runId)!.status === "running"; i++) await Bun.sleep(50);
  });

  test("没发现就不出声：回答 [SILENT] 的那一轮收起（hidden_at）", () => {
    const { role, sessionId } = roleWithHome();
    const r = routines.createRoleRoutine(role.id, { name: "q", prompt: "p", trigger: { kind: "daily", time: "08:00" }, quiet: true });
    const nodeId = "p2a-silent";
    repo.createRootInSession({ sessionId, nodeId, question: "p", now: Date.now() });
    db().prepare("UPDATE nodes SET status='done', response='`[SILENT]`' WHERE id = ?").run(nodeId);
    expect(routines.settleRoleRoutineRun(r.taskId, nodeId, "done")).toBeTrue();
    expect(repo.getNode(nodeId)!.hiddenAt).not.toBeNull();
    // 不静默的例行 / 有内容的回答不收
    db().prepare("UPDATE nodes SET hidden_at = NULL, response = '发现 2 个问题' WHERE id = ?").run(nodeId);
    expect(routines.settleRoleRoutineRun(r.taskId, nodeId, "done")).toBeFalse();
  });

  test("删例行：任务没了，角色会话不受连坐", () => {
    const { role, sessionId } = roleWithHome();
    const r = routines.createRoleRoutine(role.id, { name: "d", prompt: "p", trigger: { kind: "daily", time: "08:00" } });
    routines.deleteRoleRoutine(role.id, r.taskId);
    expect(tasks.getTask(r.taskId)).toBeNull();
    expect(repo.getSession(sessionId)!.kind).toBe("role");
  });
});

describe("后台任务", () => {
  test("来源节点在角色会话里 → 登记并列出；普通会话来源不记", () => {
    const { role, nodeId } = roleWithHome();
    repo.createSessionWithRoot({
      sessionId: "bg-1",
      nodeId: "bg-1-root",
      title: "审查 feat/x 的改动",
      question: "审查",
      now: Date.now(),
      mode: "chat",
    });
    expect(routines.recordRoleBackgroundTask({ originNodeId: nodeId, sessionId: "bg-1", nodeId: "bg-1-root" })).toBeTrue();
    const list = routines.listRoleBackgroundTasks(role.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sessionId: "bg-1", originNodeId: nodeId, title: "审查 feat/x 的改动", status: "streaming", turns: 1 });
    db().prepare("UPDATE nodes SET status = 'done', duration_ms = 660000 WHERE id = 'bg-1-root'").run();
    expect(routines.listRoleBackgroundTasks(role.id)[0]).toMatchObject({ status: "done", durationMs: 660000 });
    // 普通会话来源
    repo.createSessionWithRoot({ sessionId: "plain-1", nodeId: "plain-1-root", title: "p", question: "q", now: Date.now() });
    repo.createSessionWithRoot({ sessionId: "bg-2", nodeId: "bg-2-root", title: "p", question: "q", now: Date.now() });
    expect(routines.recordRoleBackgroundTask({ originNodeId: "plain-1-root", sessionId: "bg-2", nodeId: "bg-2-root" })).toBeFalse();
    expect(routines.recordRoleBackgroundTask({ originNodeId: undefined, sessionId: "bg-2", nodeId: "bg-2-root" })).toBeFalse();
  });
});

describe("能力", () => {
  test("工具白 / 黑名单与挂载技能；非法输入 400", () => {
    const { role } = roleWithHome();
    const c = routines.updateRoleCapabilities(role.id, {
      tools: ["Read", "Grep", "Read"],
      disallowedTools: ["Bash"],
      hostSkills: ["xhs-cards"],
    });
    expect(c.tools).toEqual(["Read", "Grep"]);
    expect(c.disallowedTools).toEqual(["Bash"]);
    expect(c.hostSkills).toEqual(["xhs-cards"]);
    expect(routines.updateRoleCapabilities(role.id, { tools: null }).tools).toBeNull();
    expect(() => routines.updateRoleCapabilities(role.id, { hostSkills: ["../x"] })).toThrow();
    expect(() => routines.updateRoleCapabilities(role.id, { tools: "Read" })).toThrow();
  });

  test("roleSpawnExtras 建好技能软链、追加后台任务说明", () => {
    const { role } = roleWithHome();
    const extras = roles.roleSpawnExtras(agents.getAgent(role.id)!, "/tmp")!;
    expect(fs.readlinkSync(path.join(role.homeDir, ".claude", "skills"))).toBe("../skills");
    expect(extras.appendSystemPrompt).toContain("## 后台任务");
    expect(extras.appendSystemPrompt).toContain("--new --workspace");
    expect(extras.addDirs).toEqual([role.homeDir]);
  });
});

describe("ctx", () => {
  test("proposalContext 读到现有记忆与技能", () => {
    const { role } = roleWithHome();
    writeMemory(role.id, "k.md", "K");
    fs.mkdirSync(path.join(role.homeDir, "skills", "s1"), { recursive: true });
    fs.writeFileSync(path.join(role.homeDir, "skills", "s1", "SKILL.md"), "---\nname: s1\ndescription: d\n---\nbody\n");
    const c = ctxOf(role.homeDir);
    expect(c.memories.get("k.md")).toBe("K");
    expect([...c.skills]).toEqual(["s1"]);
  });
});
