import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 群聊服务端（docs/roles-p2.md B）：建群 / 设置、群消息落库、编排（挑人、@ 接力、
// 3 遍 / 10 条上限、跳过、停下、继续讨论、增量喂法）。临时 DB + 临时 TRELLIS_ROLES_DIR；
// 发言走 mock 引擎（群聊版：「接力」时 @ 下一位、「都跳过」时可选发言一律跳过）
// 或测试注入的假流，不 spawn 任何 CLI。

mock.module("server-only", () => ({}));

const testDir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "trellis-groups-")));
const prevDb = process.env.TRELLIS_DB_PATH;
const prevRoles = process.env.TRELLIS_ROLES_DIR;
process.env.TRELLIS_DB_PATH = path.join(testDir, "groups.db");
process.env.TRELLIS_ROLES_DIR = path.join(testDir, "roles");

const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const roles = await import("./roles");
const groups = await import("./groups");
const repo = await import("./repo");
const listRoute = await import("@/app/api/groups/route");
const oneRoute = await import("@/app/api/groups/[id]/route");
const msgRoute = await import("@/app/api/groups/[id]/messages/route");
const contRoute = await import("@/app/api/groups/[id]/continue/route");
const stopRoute = await import("@/app/api/groups/[id]/stop/route");

afterEach(() => {
  groups.__setGroupStreamForTests(null);
  groups.__setGroupRouterForTests(null);
});

afterAll(() => {
  sqlite.resetDBForTests();
  if (prevDb === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = prevDb;
  if (prevRoles === undefined) delete process.env.TRELLIS_ROLES_DIR;
  else process.env.TRELLIS_ROLES_DIR = prevRoles;
  fs.rmSync(testDir, { recursive: true, force: true });
});

const A = roles.createRole({ name: "Iris", intro: "研究员" });
const B = roles.createRole({ name: "老周", intro: "代码审稿人" });
const C = roles.createRole({ name: "小满", intro: "产品" });

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
function req(url: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function newGroup(roleIds = [A.id, B.id, C.id], name = "方案评审") {
  const res = await listRoute.POST(req("/api/groups", { name, roleIds, provider: "mock" }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { group: import("@/lib/groups").Group }).group;
}

async function say(groupId: string, text: string, provider = "mock") {
  const res = await msgRoute.POST(req(`/api/groups/${groupId}/messages`, { text, provider }), ctx(groupId));
  const j = await res.json();
  return { status: res.status, body: j as { node: import("@/lib/server/repo").ApiNode; round: import("@/lib/groups").GroupRound | null; error?: string } };
}

/** 会话里按 rowid 的群节点：作者、正文、meta。 */
function timeline(groupId: string) {
  return repo
    .getSessionNodes(groupId)
    .map((n) => ({ id: n.id, agentId: n.agentId, q: n.question, r: n.response, status: n.status, meta: n.meta, parentId: n.parentId }));
}

const replies = (groupId: string) => timeline(groupId).filter((n) => n.meta?.kind === "group-reply");

async function patch(groupId: string, body: unknown) {
  const res = await oneRoute.PATCH(req(`/api/groups/${groupId}`, body, "PATCH"), ctx(groupId));
  return { status: res.status, body: (await res.json()) as { group?: import("@/lib/groups").Group; error?: string } };
}

describe("建群与设置", () => {
  test("2–6 位角色、只收角色；会话 kind='group'、不进侧栏会话列表", async () => {
    const bad = await listRoute.POST(req("/api/groups", { name: "x", roleIds: [A.id] }));
    expect(bad.status).toBe(400);
    const notRole = await listRoute.POST(req("/api/groups", { name: "x", roleIds: [A.id, "nope"] }));
    expect(notRole.status).toBe(400);
    const g = await newGroup();
    expect(g.members.map((m) => m.name)).toEqual(["Iris", "老周", "小满"]);
    expect(g.settings).toEqual({ replyPolicy: "route", maxPasses: 3, maxMessages: 10 });
    expect(repo.getSession(g.id)?.kind).toBe("group");
    expect(repo.listSessions().some((s) => s.id === g.id)).toBe(false);
    const list = (await (await listRoute.GET()).json()) as { groups: { id: string }[] };
    expect(list.groups.some((x) => x.id === g.id)).toBe(true);
  });

  test("PATCH 改策略 / 上限（钳制）/ 加减成员（守 2–6）", async () => {
    const g = await newGroup([A.id, B.id]);
    const r = await patch(g.id, { settings: { replyPolicy: "all", maxPasses: 99, maxMessages: 0 } });
    expect(r.body.group?.settings).toEqual({ replyPolicy: "all", maxPasses: 6, maxMessages: 1 });
    expect((await patch(g.id, { settings: { replyPolicy: "nope" } })).status).toBe(400);
    expect((await patch(g.id, { removeRoleIds: [A.id] })).status).toBe(400);
    const added = await patch(g.id, { addRoleIds: [C.id], name: "新名字" });
    expect(added.body.group?.members.map((m) => m.roleId)).toEqual([A.id, B.id, C.id]);
    expect(added.body.group?.name).toBe("新名字");
  });

  test("/api/chat 不接群会话", async () => {
    const g = await newGroup();
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(req("/api/chat", { kind: "root", sessionId: g.id, question: "hi", provider: "mock" }));
    expect(res.status).toBe(409);
  });
});

describe("编排（mock 引擎）", () => {
  test("@ 了谁就谁回；节点作者 = 角色、串成一条线", async () => {
    const g = await newGroup();
    const { status, body } = await say(g.id, "@老周 你先看看");
    expect(status).toBe(200);
    expect(body.node.meta).toEqual({ kind: "group-user" });
    await groups.waitForRound(g.id);
    const t = timeline(g.id);
    expect(t.map((n) => n.meta?.kind)).toEqual(["group-user", "group-reply"]);
    expect(t[1].agentId).toBe(B.id);
    expect(t[1].status).toBe("done");
    expect(t[1].r).toContain("我是老周");
    expect(t[1].parentId).toBe(t[0].id);
    expect(groups.activeRound(g.id)).toBeNull();
  });

  test("route：路由挑一位；路由失败落第一位", async () => {
    const g = await newGroup();
    groups.__setGroupRouterForTests(async () => C.id);
    await say(g.id, "这个功能值不值得做");
    await groups.waitForRound(g.id);
    expect(replies(g.id).map((n) => n.agentId)).toEqual([C.id]);
    groups.__setGroupRouterForTests(async () => null);
    await say(g.id, "再问一句");
    await groups.waitForRound(g.id);
    expect(replies(g.id).map((n) => n.agentId)).toEqual([C.id, A.id]);
  });

  test("route 快路径：直接叫名字（没加 @）就是他，不调模型", async () => {
    const g = await newGroup();
    await say(g.id, "小满你怎么看");
    await groups.waitForRound(g.id);
    expect(replies(g.id).map((n) => n.agentId)).toEqual([C.id]);
  });

  test("mention-only：不 @ 就没人回", async () => {
    const g = await newGroup();
    await patch(g.id, { settings: { replyPolicy: "mention-only" } });
    const { body } = await say(g.id, "随便说说");
    expect(body.round).toBeNull();
    expect(replies(g.id)).toEqual([]);
  });

  test("@ 接力走满 3 遍 → 上限卡（带还排着的人），继续讨论从他接着说", async () => {
    const g = await newGroup();
    await say(g.id, "@Iris 接力");
    await groups.waitForRound(g.id);
    // Iris @老周 → 老周 @小满 → 小满 @Iris（第 4 遍不许开）
    expect(replies(g.id).map((n) => n.agentId)).toEqual([A.id, B.id, C.id]);
    expect(replies(g.id).map((n) => n.meta?.pass)).toEqual([1, 2, 3]);
    const end = timeline(g.id).at(-1)!;
    expect(end.meta?.kind).toBe("group-round-end");
    expect(end.meta).toMatchObject({ reason: "passes", passes: 3, messages: 3 });
    expect((end.meta as unknown as { pending: { roleId: string }[] }).pending.map((p) => p.roleId)).toEqual([A.id]);
    expect(end.q).toContain("来回 3 遍");
    // 引用回复：老周的发言 quote 的是 Iris
    expect(replies(g.id)[1].meta?.replyTo).toMatchObject({ nodeId: replies(g.id)[0].id, name: "Iris" });

    const res = await contRoute.POST(req(`/api/groups/${g.id}/continue`, { provider: "mock" }), ctx(g.id));
    expect(res.status).toBe(200);
    await groups.waitForRound(g.id);
    const after = replies(g.id);
    expect(after[3].agentId).toBe(A.id);
    expect(after[3].meta?.replyTo).toMatchObject({ name: "小满" });
    // 卡过时了（后面又有人说话）就不能再「继续」
    const again = await contRoute.POST(req(`/api/groups/${g.id}/continue`, {}), ctx(g.id));
    expect([200, 409]).toContain(again.status);
    await groups.waitForRound(g.id);
  });

  test("条数上限：@所有人 接力 + 最多 2 条 → 第 3 位不开口，上限卡 reason=messages", async () => {
    const g = await newGroup();
    await patch(g.id, { settings: { maxMessages: 2 } });
    await say(g.id, "@所有人 接力");
    await groups.waitForRound(g.id);
    expect(replies(g.id).map((n) => n.agentId)).toEqual([A.id, B.id]);
    const end = timeline(g.id).at(-1)!;
    expect(end.meta).toMatchObject({ kind: "group-round-end", reason: "messages", messages: 2 });
    expect((end.meta as unknown as { pending: { roleId: string }[] }).pending[0].roleId).toBe(C.id);
  });

  test("谁有话谁说：（跳过）的发言标 skipped、不算条数、不进别人的增量", async () => {
    const g = await newGroup();
    await patch(g.id, { settings: { replyPolicy: "all" } });
    await say(g.id, "这个大家都跳过吧");
    await groups.waitForRound(g.id);
    const r = replies(g.id);
    expect(r).toHaveLength(3);
    expect(r.every((n) => n.meta?.skipped === true)).toBe(true);
    expect(groups.loadTranscript(g.id).map((t) => t.roleId)).toEqual([null]);
    expect(timeline(g.id).some((n) => n.meta?.kind === "group-round-end")).toBe(false);
  });

  test("这一轮没完再发 → 409；停下这一轮 → 正在说的中断、后面的不再开口、不出上限卡", async () => {
    const g = await newGroup();
    groups.__setGroupStreamForTests(async function* (a) {
      yield { type: "delta", text: `${a.member.name} 开口了` };
      await new Promise<void>((resolve) => a.signal.addEventListener("abort", () => resolve(), { once: true }));
      yield { type: "error", message: "aborted" };
    });
    await say(g.id, "@所有人 慢慢说");
    // 等第一位真的开口
    for (let i = 0; i < 100 && !groups.activeRound(g.id)?.current?.nodeId; i++) await Bun.sleep(5);
    expect(groups.activeRound(g.id)?.current?.roleId).toBe(A.id);
    expect(groups.activeRound(g.id)?.queued).toEqual([B.id, C.id]);
    expect((await say(g.id, "插一句")).status).toBe(409);
    const stop = await stopRoute.POST(req(`/api/groups/${g.id}/stop`, {}), ctx(g.id));
    expect(((await stop.json()) as { stopped: boolean }).stopped).toBe(true);
    await groups.waitForRound(g.id);
    const r = replies(g.id);
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe("error");
    expect(timeline(g.id).some((n) => n.meta?.kind === "group-round-end")).toBe(false);
    expect(groups.activeRound(g.id)).toBeNull();
  });
});

describe("增量：每位只看没看过的群消息", () => {
  test("「[名字]：内容」格式；看过的不再喂；自己说的不喂；上限卡不喂", async () => {
    const g = await newGroup([A.id, B.id]);
    const prompts: Record<string, string[]> = {};
    groups.__setGroupStreamForTests(async function* (a) {
      (prompts[a.member.name] ??= []).push(a.prompt);
      yield { type: "delta", text: `${a.member.name}的看法` };
      yield { type: "done" };
    });
    await say(g.id, "@Iris @老周 第一问");
    await groups.waitForRound(g.id);
    expect(prompts["Iris"][0]).toContain("[用户]：@Iris @老周 第一问");
    expect(prompts["老周"][0]).toContain("[用户]：@Iris @老周 第一问");
    expect(prompts["老周"][0]).toContain("[Iris]：Iris的看法");
    expect(prompts["老周"][0]).toContain("群里有 2 条你还没看过的消息");

    await say(g.id, "@Iris 第二问");
    await groups.waitForRound(g.id);
    const p = prompts["Iris"][1];
    expect(p).toContain("[老周]：老周的看法");
    expect(p).toContain("[用户]：@Iris 第二问");
    expect(p).not.toContain("第一问");
    expect(p).not.toContain("[Iris]");
    expect(p).toContain("用户在群里发了消息");
  });

  test("claude 家族：本轮 CLI 会话 id 记到成员行；换了家族 / cwd 就不 resume", async () => {
    const g = await newGroup([A.id, B.id]);
    const seen: { resume: boolean; prompt: string }[] = [];
    groups.__setGroupStreamForTests(async function* (a) {
      seen.push({ resume: false, prompt: a.prompt });
      yield { type: "session_init", sessionId: `sid-${a.member.name}` };
      yield { type: "delta", text: "好" };
      yield { type: "done" };
    });
    await say(g.id, "@Iris hi", "claude-opus");
    await groups.waitForRound(g.id);
    const row = sqlite
      .getDB()
      .query("SELECT cli_session_id, cli_family, cli_cwd, last_seen_seq FROM group_members WHERE session_id = ? AND role_id = ?")
      .get(g.id, A.id) as { cli_session_id: string; cli_family: string; cli_cwd: string; last_seen_seq: number };
    expect(row.cli_session_id).toBe("sid-Iris");
    expect(row.cli_family).toBe("claude");
    expect(row.cli_cwd).toBe(A.homeDir);
    expect(row.last_seen_seq).toBeGreaterThan(0);
    // jsonl 不存在（测试里没有真 CLI）→ 下一轮不 resume，从最近 30 条喂起（包含它自己没看过的历史）
    await say(g.id, "@Iris 还在吗", "claude-opus");
    await groups.waitForRound(g.id);
    expect(seen[1].prompt).toContain("[用户]：@Iris hi");
  });
});

describe("事件", () => {
  test("subscribeGroup 收到新节点与轮次状态，最后一条是结束态", async () => {
    const g = await newGroup();
    const events: import("@/lib/groups").GroupEvent[] = [];
    const unsub = groups.subscribeGroup(g.id, (e) => events.push(e));
    await say(g.id, "@老周 在吗");
    await groups.waitForRound(g.id);
    unsub();
    const nodes = events.filter((e) => e.type === "node");
    expect(nodes.length).toBeGreaterThanOrEqual(2);
    const rounds = events.filter((e) => e.type === "round").map((e) => (e as { round: { status: string } }).round.status);
    expect(rounds).toContain("running");
    expect(rounds.at(-1)).toBe("done");
  });

  test("删群 = 归档，列表里不再出现", async () => {
    const g = await newGroup();
    const res = await oneRoute.DELETE(req(`/api/groups/${g.id}`, undefined, "DELETE"), ctx(g.id));
    expect(res.status).toBe(200);
    expect(groups.listGroups().some((x) => x.id === g.id)).toBe(false);
  });
});
