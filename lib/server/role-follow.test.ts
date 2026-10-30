import { afterAll, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 角色 P4「跟进我的会话」（docs/roles-p2.md C）：状态比较（新进入 / 去重 / 卡住 / Herdr 断线）、
// 开关互斥、基线静默、有变化插清单节点 + 飞书推送、没变化不出声。临时 DB + 临时角色目录，
// Herdr 窗格与飞书推送注入假实现，不碰 socket / 网络。

mock.module("server-only", () => ({}));

const testDir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "trellis-follow-")));
const prev = { db: process.env.TRELLIS_DB_PATH, roles: process.env.TRELLIS_ROLES_DIR, lark: process.env.TRELLIS_LARK };
process.env.TRELLIS_DB_PATH = path.join(testDir, "f.db");
process.env.TRELLIS_ROLES_DIR = path.join(testDir, "roles");

const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const repo = await import("./repo");
const roles = await import("./roles");
const follow = await import("./role-follow");
const { createLarkBot, ensureLarkChat } = await import("./lark/store");
type HerdrConsolePane = import("@/lib/herdr-console").HerdrConsolePane;

afterAll(() => {
  sqlite.resetDBForTests();
  for (const [k, v] of [["TRELLIS_DB_PATH", prev.db], ["TRELLIS_ROLES_DIR", prev.roles], ["TRELLIS_LARK", prev.lark]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(testDir, { recursive: true, force: true });
});

const MIN = 60_000;

function obs(subject: string, state: import("./role-follow").FollowObservation["state"], extra: Partial<import("./role-follow").FollowObservation> = {}) {
  return { subject, source: "session" as const, state, token: "n1", sessionId: subject.slice(2), title: subject, detail: null, ...extra };
}

describe("diffFollow", () => {
  test("新进入才报；同一状态同一节点不再报；换一轮（token）再失败算新进入；离开即删行", () => {
    let rows = new Map<string, import("./role-follow").FollowStateRow>();
    const step = (o: ReturnType<typeof obs>[], now = 0) => {
      const r = follow.diffFollow(rows, o, now, 20 * MIN, { herdrAvailable: true });
      rows = new Map(r.next.map((x) => [x.subject, x]));
      return r.report.map((x) => `${x.subject}:${x.state}`);
    };
    expect(step([obs("s:a", "failed"), obs("s:b", "done")])).toEqual(["s:a:failed", "s:b:done"]);
    expect(step([obs("s:a", "failed"), obs("s:b", "done")])).toEqual([]);
    expect(step([obs("s:a", "failed", { token: "n2" })])).toEqual(["s:a:failed"]);
    expect(rows.has("s:b")).toBe(false); // b 被读了 → 离开 → 删行
    expect(step([obs("s:b", "done")])).toEqual(["s:b:done"]); // 再进来 = 新进入
    expect(step([obs("s:a", "waiting", { token: "n2" })])).toEqual(["s:a:waiting"]); // 同节点换状态
  });

  test("卡住：输出指纹 N 分钟没变才报，只报一次；有新输出回到在跑，再卡住再报", () => {
    let rows = new Map<string, import("./role-follow").FollowStateRow>();
    const step = (sig: string, now: number) => {
      const r = follow.diffFollow(rows, [obs("s:x", "running", { progressSig: sig })], now, 20 * MIN, { herdrAvailable: true });
      rows = new Map(r.next.map((x) => [x.subject, x]));
      return r.report;
    };
    expect(step("10:0", 0)).toEqual([]);
    expect(step("10:0", 15 * MIN)).toEqual([]);
    const rep = step("10:0", 30 * MIN);
    expect(rep.map((r) => r.state)).toEqual(["stuck"]);
    expect(rep[0].detail).toContain("30 分钟没有新输出");
    expect(step("10:0", 45 * MIN)).toEqual([]);
    expect(step("99:1", 60 * MIN)).toEqual([]); // 有新输出
    expect(step("99:1", 90 * MIN).map((r) => r.state)).toEqual(["stuck"]);
  });

  test("Herdr 这次没连上：h: 行原样保留，重连后不重复报", () => {
    const herdr = { ...obs("h:p1", "waiting"), source: "herdr" as const, token: "" };
    const first = follow.diffFollow(new Map(), [herdr], 0, 20 * MIN, { herdrAvailable: true });
    expect(first.report.length).toBe(1);
    const rows = new Map(first.next.map((x) => [x.subject, x]));
    const offline = follow.diffFollow(rows, [], MIN, 20 * MIN, { herdrAvailable: false });
    expect(offline.next.map((x) => x.subject)).toEqual(["h:p1"]);
    const back = follow.diffFollow(new Map(offline.next.map((x) => [x.subject, x])), [herdr], 2 * MIN, 20 * MIN, { herdrAvailable: true });
    expect(back.report).toEqual([]);
  });

  test("observeHerdr：need → 等你、working 带活动时刻、done → 完成；shell / 离线不跟", () => {
    const pane = (key: string, lane: HerdrConsolePane["lane"], status: HerdrConsolePane["status"], activityAt: number | null = null): HerdrConsolePane => ({
      key, paneId: key, workspaceId: "w", workspaceLabel: "trellis", tabId: "t", tabLabel: "tab", title: `窗格 ${key}`,
      lane, status, agentKind: "claude", sessionId: `sess-${key}`, view: null, lastTool: null, activityAt, queued: 0, focused: false, cwd: null,
    });
    const o = follow.observeHerdr([
      pane("a", "need", "waiting"),
      pane("b", "run", "working", 123),
      pane("c", "idle", "done"),
      pane("d", "shell", null),
      pane("e", "off", "unknown"),
    ]);
    expect(o.map((x) => [x.subject, x.state])).toEqual([["h:a", "waiting"], ["h:b", "running"], ["h:c", "done"]]);
    expect(o[1].progressAt).toBe(123);
    expect(o[0].sessionId).toBe("sess-a");
  });
});

function seed(id: string, status: "done" | "error" | "streaming", opts: { error?: string; readAt?: number | null; pending?: boolean } = {}) {
  const now = Date.now();
  repo.createSessionWithRoot({ sessionId: id, nodeId: `${id}-n`, title: `会话 ${id}`, question: `问 ${id}`, now, mode: "chat" });
  sqlite.getDB()
    .prepare("UPDATE nodes SET status = ?, error_message = ?, read_at = ?, pending_interaction_json = ?, response = 'r' WHERE id = ?")
    .run(
      status,
      opts.error ?? null,
      opts.readAt === undefined ? now : opts.readAt,
      opts.pending ? JSON.stringify({ toolUseId: "tu1", toolName: "AskUserQuestion", input: { questions: [{ question: "选哪个？" }] } }) : null,
      `${id}-n`,
    );
}

describe("开关与扫描", () => {
  const pushes: { botId: string; chatId: string; markdown: string; title: string }[] = [];
  let clock = Date.now();
  const deps = {
    now: () => clock,
    herdrPanes: () => [] as HerdrConsolePane[],
    pushLark: async (a: (typeof pushes)[number]) => {
      pushes.push(a);
      return { status: "sent" };
    },
    publicUrl: () => "https://trellis.example.com",
  };
  const nodesIn = (sid: string) =>
    (sqlite.getDB().prepare("SELECT COUNT(*) AS n FROM nodes WHERE session_id = ?").get(sid) as { n: number }).n;

  test("全局只能一个角色开；关掉只认自己", () => {
    const a = roles.createRole({ name: "Follow A" });
    const b = roles.createRole({ name: "Follow B" });
    expect(follow.getFollowStatus(a.id).enabled).toBe(false);
    follow.setFollow(a.id, { enabled: true, staleMinutes: 30 });
    expect(follow.getFollowStatus(a.id)).toMatchObject({ enabled: true, activeRoleId: a.id, staleMinutes: 30 });
    const sb = follow.setFollow(b.id, { enabled: true });
    expect(sb).toMatchObject({ enabled: true, activeRoleId: b.id, staleMinutes: 30 });
    expect(follow.getFollowStatus(a.id)).toMatchObject({ enabled: false, activeRoleId: b.id, activeRoleName: "Follow B" });
    follow.setFollow(a.id, { enabled: false }); // a 本来就没开：不动 b
    expect(follow.getFollowStatus(b.id).enabled).toBe(true);
    follow.setFollow(b.id, { enabled: false });
    expect(follow.getFollowStatus(b.id).activeRoleId).toBeNull();
  });

  test("没开 → off；打开后第一扫只拍基线；新失败 → 插清单节点（建出固定会话）+ 飞书推送；再扫不出声", async () => {
    expect((await follow.scanFollow({ force: true, deps })).status).toBe("off");
    seed("old-fail", "error", { error: "老错误" });
    const role = roles.createRole({ name: "跟进员" });
    const bot = createLarkBot({ name: "bot", appId: "cli_x", appSecret: "s", agentId: role.id });
    ensureLarkChat(bot.id, "oc_p2p", "p2p", "私聊", Date.now());
    follow.setFollow(role.id, { enabled: true });

    const base = await follow.scanFollow({ deps });
    expect(base.status).toBe("baseline");
    expect(roles.getRole(role.id)!.homeSessionId).toBeNull(); // 基线不出声

    // 15 分钟内不到点
    clock += 5 * MIN;
    expect((await follow.scanFollow({ deps })).status).toBe("not-due");

    seed("new-fail", "error", { error: "Agent 超时" });
    seed("new-done", "done", { readAt: null });
    seed("new-ask", "streaming", { pending: true });
    seed("user-stop", "error", { error: "aborted" });
    clock += 15 * MIN;
    const r = await follow.scanFollow({ deps });
    expect(r.status).toBe("reported");
    if (r.status !== "reported") throw new Error("unreachable");
    expect(r.items.map((i) => `${i.sessionId}:${i.state}`).sort()).toEqual(["new-ask:waiting", "new-done:done", "new-fail:failed"]);
    const home = roles.getRole(role.id)!.homeSessionId!;
    expect(home).toBe(r.sessionId);
    expect(repo.getSession(home)!.kind).toBe("role");
    const node = repo.getNode(r.nodeId)!;
    expect(node.status).toBe("done");
    expect(node.question).toBe("跟进：1 个等你、1 个失败、1 个完成");
    expect(node.response).toContain("[会话 new-fail](/?session=new-fail)");
    expect(node.meta?.kind).toBe("role-follow");
    expect((node.meta as { items: unknown[] }).items.length).toBe(3);
    expect(pushes.length).toBe(1);
    expect(pushes[0]).toMatchObject({ botId: bot.id, chatId: "oc_p2p" });
    expect(pushes[0].markdown).toContain("https://trellis.example.com/?session=new-fail");

    // 没变化：不出声、不插节点、不推送
    const count = nodesIn(home);
    clock += 15 * MIN;
    expect((await follow.scanFollow({ deps })).status).toBe("quiet");
    expect(nodesIn(home)).toBe(count);
    expect(pushes.length).toBe(1);

    // 再来一个新失败：插进同一条固定会话
    seed("fail-2", "error", { error: "x" });
    const r2 = await follow.scanFollow({ force: true, deps });
    expect(r2.status === "reported" && r2.sessionId).toBe(home);
    expect(nodesIn(home)).toBe(count + 1);
  });

  test("TRELLIS_LARK=off：真推送通道直接跳过（不读凭证、不发）", async () => {
    process.env.TRELLIS_LARK = "off";
    seed("fail-3", "error", { error: "y" });
    const { herdrPanes, now } = deps;
    const r = await follow.scanFollow({ force: true, deps: { herdrPanes, now } });
    expect(r.status).toBe("reported");
    if (r.status === "reported") expect(r.lark).toEqual({ status: "skipped", reason: "TRELLIS_LARK=off" });
  });
});
