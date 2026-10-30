import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

mock.module("server-only", () => ({}));
const dir = mkdtempSync(path.join(tmpdir(), "trellis-session-relay-"));
const previousPath = process.env.TRELLIS_DB_PATH;
process.env.TRELLIS_DB_PATH = path.join(dir, "data.db");
const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const repo = await import("./repo");
const relay = await import("./session-relay");
const { RELAY_LIMITS, parseRelayFile } = await import("@/lib/session-relay");
const importRoute = await import("@/app/api/import/session/route");
const exportRoute = await import("@/app/api/export/session/[id]/route");

afterAll(() => {
  sqlite.resetDBForTests();
  if (previousPath === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = previousPath;
  rmSync(dir, { recursive: true, force: true });
});

let clock = 1_000;
function done(nodeId: string, response: string) {
  repo.appendNodeResponse(nodeId, response);
  repo.finalizeNode({ nodeId, status: "done", tokenInput: 1, tokenOutput: 1, tokenCacheRead: 0, tokenCacheCreation: 0, now: ++clock });
}

/** 源会话：根 q1 → q2（带附件 + 工具调用）→ q3（叶，选中分支），另有一条 q2 的兄弟分支 side。 */
function seedSource() {
  const sid = crypto.randomUUID();
  const n1 = crypto.randomUUID();
  repo.createSessionWithRoot({ sessionId: sid, nodeId: n1, title: "源会话", question: "q1 问题", now: ++clock, systemPrompt: "自定义人设" });
  done(n1, "a1 回答");
  const n2 = crypto.randomUUID();
  repo.createBranchNode({
    nodeId: n2, parentId: n1, question: "q2 问题", parentAnchor: { selectedText: "a1" }, now: ++clock,
    attachments: [{ hash: "a".repeat(64), mime: "text/csv", size: 12, filename: "data.csv" }],
  });
  repo.appendToolCallStart({
    nodeId: n2,
    call: { id: "t1", name: "Bash", input: { command: "ls -la /secret" }, output: "SECRET OUTPUT", stderr: null, status: "done", durationMs: 5, startedAt: clock, endedAt: clock },
  });
  done(n2, "a2 回答");
  const side = crypto.randomUUID();
  repo.createBranchNode({ nodeId: side, parentId: n1, question: "side 分支", parentAnchor: null, now: ++clock });
  done(side, "side 回答");
  const n3 = crypto.randomUUID();
  repo.createBranchNode({ nodeId: n3, parentId: n2, question: "q3 问题", parentAnchor: null, now: ++clock });
  done(n3, "a3 回答");
  return { sid, n1, n2, n3, side };
}

describe("export → import 往返", () => {
  test("导入后消息链与源分支一致，标题带来源，旁支不跟", () => {
    const src = seedSource();
    const file = relay.exportRelaySession(src.sid, src.n3);
    expect(file.version).toBe(1);
    expect(file.messages.map((m) => m.question)).toEqual(["q1 问题", "q2 问题", "q3 问题"]);
    expect(file.source.totalNodes).toBe(4);
    expect(file.session.systemPrompt).toBe("自定义人设");
    // 工具只带摘要，不带输出
    expect(JSON.stringify(file)).not.toContain("SECRET OUTPUT");
    expect(file.messages[1].toolCalls).toHaveLength(1);
    expect(file.messages[1].attachments).toEqual([{ filename: "data.csv", mime: "text/csv", size: 12 }]);

    // 走一遍 JSON 序列化，模拟跨机传输
    const res = relay.importRelaySession(JSON.parse(JSON.stringify(file)), { from: "devbox-1" });
    expect(res.path).toBe(`/?session=${res.sessionId}&node=${res.leafNodeId}`);
    const session = repo.getSession(res.sessionId)!;
    expect(session.title).toBe("源会话（接力自 devbox-1）");
    expect(session.mode).toBe("chat");
    expect(session.systemPrompt).toBe("自定义人设");
    expect(session.bindingType).toBe("legacy");

    const chain = repo.getNodeChain(res.leafNodeId);
    expect(chain.map((n) => n.question)).toEqual([
      "q1 问题",
      "q2 问题\n\n（原附件没有随接力带过来：data.csv）",
      "q3 问题",
    ]);
    expect(chain.map((n) => n.response)).toEqual(["a1 回答", "a2 回答", "a3 回答"]);
    expect(chain.every((n) => n.status === "done")).toBeTrue();
    expect(chain[1].parentAnchor).toEqual({ selectedText: "a1" });
    expect(chain[1].attachments).toEqual([]);
    expect(chain[1].toolCalls.map((t) => t.name)).toEqual(["Bash"]);
    expect(repo.getSessionNodes(res.sessionId)).toHaveLength(3);
    expect(session.rootNodeId).toBe(chain[0].id);

    // 再导出导入一次，链不变（幂等往返）
    const again = relay.exportRelaySession(res.sessionId);
    expect(again.messages.map((m) => [m.question, m.response])).toEqual(
      chain.map((n) => [n.question, n.response]),
    );
  });

  test("不指定 nodeId 时导出最近活动节点所在的链", () => {
    const src = seedSource();
    const file = relay.exportRelaySession(src.sid);
    expect(file.source.leafNodeId).toBe(src.n3);
    const side = relay.exportRelaySession(src.sid, src.side);
    expect(side.messages.map((m) => m.question)).toEqual(["q1 问题", "side 分支"]);
  });

  test("还在生成的节点导出成 error + 说明，导入后是终态", () => {
    const sid = crypto.randomUUID();
    const n1 = crypto.randomUUID();
    repo.createSessionWithRoot({ sessionId: sid, nodeId: n1, title: "流式", question: "q", now: ++clock });
    repo.appendNodeResponse(n1, "半截");
    const file = relay.exportRelaySession(sid);
    expect(file.messages[0].status).toBe("error");
    const res = relay.importRelaySession(file);
    expect(repo.getNode(res.leafNodeId)!.status).toBe("error");
    expect(repo.getSession(res.sessionId)!.title).toBe("流式（接力）");
  });

  test("指定本机 workspacePath → project 模式；路径不存在拒绝", () => {
    const src = seedSource();
    const file = relay.exportRelaySession(src.sid, src.n3);
    const ws = path.join(dir, "ws");
    mkdirSync(ws, { recursive: true });
    const res = relay.importRelaySession(file, { workspacePath: ws });
    const s = repo.getSession(res.sessionId)!;
    expect(s.mode).toBe("project");
    expect(s.workspacePath).toBe(ws);
    expect(s.systemPrompt).toBeNull();
    expect(repo.isLineageIsolated(res.sessionId)).toBeTrue();
    expect(() => relay.importRelaySession(file, { workspacePath: path.join(dir, "nope") })).toThrow(/不存在/);
    expect(() => relay.importRelaySession(file, { workspacePath: "relative/dir" })).toThrow(/绝对路径/);
  });

  test("导出：会话 / 节点不存在 → 404", () => {
    const src = seedSource();
    expect(() => relay.exportRelaySession("missing")).toThrow(relay.RelayError);
    const other = seedSource();
    try {
      relay.exportRelaySession(src.sid, other.n3);
      throw new Error("should throw");
    } catch (e) {
      expect((e as InstanceType<typeof relay.RelayError>).status).toBe(404);
    }
  });
});

describe("续聊上下文", () => {
  test("导入会话的下一轮能拿到整条接力历史；原生会话返回 null", () => {
    const src = seedSource();
    const res = relay.importRelaySession(relay.exportRelaySession(src.sid, src.n3), { from: "home" });
    const next = crypto.randomUUID();
    repo.createBranchNode({ nodeId: next, parentId: res.leafNodeId, question: "继续", parentAnchor: null, now: ++clock });
    const history = relay.buildRelayHistory(next)!;
    expect(history[0].role).toBe("user");
    expect(history[0].content).toContain("机器「home」接力");
    const body = history.slice(1);
    expect(body.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(body[0].content).toBe("q1 问题");
    expect(body[3].content).toContain("a2 回答");
    expect(body[3].content).toContain("[这一轮调用过的工具]");
    expect(body[5].content).toBe("a3 回答");
    // 对照：普通折叠有深度窗口（默认 2 轮），接力折叠拿到的是全部 3 轮
    expect(repo.buildHistoryForNode(next).length).toBe(4);

    // 原生会话不受影响
    expect(relay.buildRelayHistory(src.n3)).toBeNull();
  });

  test("超长历史按轮从最老的开始丢，并注明省略了几轮", () => {
    const big = "字".repeat(100_000);
    const messages = Array.from({ length: 5 }, (_, i) => ({
      kind: "qa", question: `q${i}`, response: big, status: "done", errorMessage: null,
      createdAt: i, parentAnchor: null, topicLabel: null, toolCalls: [], attachments: [], reference: null,
    }));
    const file = {
      format: "trellis-session-relay", version: 1, exportedAt: 1,
      source: { sessionId: "s", leafNodeId: "n", workspaceName: null, totalNodes: 5 },
      session: { title: "长", mode: "chat", model: null, systemPrompt: null, agentSlug: null, requireApproval: false },
      messages,
    };
    const res = relay.importRelaySession(file);
    const next = crypto.randomUUID();
    repo.createBranchNode({ nodeId: next, parentId: res.leafNodeId, question: "继续", parentAnchor: null, now: ++clock });
    const history = relay.buildRelayHistory(next)!;
    expect(history[0].content).toContain("更早的 3 轮");
    expect(history.slice(1).map((m) => m.content.slice(0, 2))).toEqual(["q3", big.slice(0, 2), "q4", big.slice(0, 2)]);
  });
});

describe("导入校验", () => {
  const good = () => ({
    format: "trellis-session-relay", version: 1, exportedAt: 1,
    source: { sessionId: "s", leafNodeId: "n", workspaceName: null, totalNodes: 1 },
    session: { title: "t", mode: "chat", model: null, systemPrompt: null, agentSlug: null, requireApproval: false },
    messages: [{ kind: "qa", question: "q", response: "a", status: "done", errorMessage: null, createdAt: 1, parentAnchor: null, topicLabel: null, toolCalls: [], attachments: [], reference: null }],
  });

  test("合法输入通过，多余字段被丢弃", () => {
    const f = { ...good(), evil: "x" } as Record<string, unknown>;
    const r = parseRelayFile(f);
    expect(r.ok).toBeTrue();
    if (r.ok) expect("evil" in r.file).toBeFalse();
  });

  const cases: [string, (f: ReturnType<typeof good>) => unknown][] = [
    ["非对象", () => "hello"],
    ["数组", () => []],
    ["错误 format", (f) => ({ ...f, format: "other" })],
    ["未知 version", (f) => ({ ...f, version: 2 })],
    ["空 messages", (f) => ({ ...f, messages: [] })],
    ["messages 非数组", (f) => ({ ...f, messages: "x" })],
    ["question 非字符串", (f) => ({ ...f, messages: [{ ...f.messages[0], question: 1 }] })],
    ["status 非法", (f) => ({ ...f, messages: [{ ...f.messages[0], status: "streaming" }] })],
    ["createdAt 负数", (f) => ({ ...f, messages: [{ ...f.messages[0], createdAt: -1 }] })],
    ["mode 非法", (f) => ({ ...f, session: { ...f.session, mode: "workspace" } })],
    ["超长 response", (f) => ({ ...f, messages: [{ ...f.messages[0], response: "x".repeat(RELAY_LIMITS.maxText + 1) }] })],
    ["消息过多", (f) => ({ ...f, messages: Array(RELAY_LIMITS.maxMessages + 1).fill(f.messages[0]) })],
    ["工具摘要过长", (f) => ({ ...f, messages: [{ ...f.messages[0], toolCalls: [{ name: "Bash", status: "done", summary: "x".repeat(RELAY_LIMITS.maxToolSummary + 1) }] }] })],
    ["reference 不在链首", (f) => ({ ...f, messages: [f.messages[0], { ...f.messages[0], kind: "reference", reference: { sourceType: "paste", sourceUri: null, contentMd: "x", title: null } }] })],
    ["reference 缺 payload", (f) => ({ ...f, messages: [{ ...f.messages[0], kind: "reference" }] })],
    ["source 缺失", (f) => ({ ...f, source: undefined })],
  ];
  for (const [name, mutate] of cases) {
    test(`拒绝：${name}`, () => {
      const r = parseRelayFile(mutate(good()));
      expect(r.ok).toBeFalse();
      expect(() => relay.importRelaySession(mutate(good()))).toThrow(relay.RelayError);
    });
  }

  test("from 必须是机器名", () => {
    expect(() => relay.importRelaySession(good(), { from: "../evil" })).toThrow(/机器名/);
  });

  test("拒绝的输入不留半截会话", () => {
    const before = repo.listSessions().length;
    try {
      relay.importRelaySession({ ...good(), version: 9 });
    } catch {
      /* expected */
    }
    expect(repo.listSessions().length).toBe(before);
  });
});

describe("路由薄壳", () => {
  const post = (body: string, headers: Record<string, string> = {}) =>
    importRoute.POST(new Request("http://x/api/import/session", { method: "POST", body, headers: { "content-type": "application/json", ...headers } }));

  test("导出 → 导入 HTTP 往返，201 返回路径", async () => {
    const src = seedSource();
    const exp = await exportRoute.GET(new Request(`http://x/api/export/session/${src.sid}?nodeId=${src.n2}`), { params: Promise.resolve({ id: src.sid }) });
    expect(exp.status).toBe(200);
    const file = await exp.json();
    expect(file.messages).toHaveLength(2);
    const imp = await post(JSON.stringify({ file, from: "home" }));
    expect(imp.status).toBe(201);
    const out = await imp.json();
    expect(out.path).toContain(out.sessionId);
    expect(repo.getSession(out.sessionId)!.title).toContain("接力自 home");
  });

  test("坏 JSON 400、坏字段 400、超大 413、导出不存在 404", async () => {
    expect((await post("{not json")).status).toBe(400);
    expect((await post(JSON.stringify({ file: { format: "x" } }))).status).toBe(400);
    expect((await post(JSON.stringify({ file: {}, from: 42 }))).status).toBe(400);
    expect((await post("{}", { "content-length": String(RELAY_LIMITS.maxBytes * 2) })).status).toBe(413);
    expect((await post(" ".repeat(RELAY_LIMITS.maxBytes + 128 * 1024))).status).toBe(413);
    const miss = await exportRoute.GET(new Request("http://x/api/export/session/none"), { params: Promise.resolve({ id: "none" }) });
    expect(miss.status).toBe(404);
  });
});
