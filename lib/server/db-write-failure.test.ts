import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// S176：把「SQLite 写不进去」从「静默转圈」变成「明确报错 + 节点落 error」。
// 注入故障走 db-error 的测试闸（磁盘满没法在单测里真造出来），走的是**真实的
// repo / run-bus 代码路径**，不是 mock 掉被测对象本身。

mock.module("server-only", () => ({}));
const dir = mkdtempSync(path.join(tmpdir(), "trellis-dbfail-"));
const previous = process.env.TRELLIS_DB_PATH;
process.env.TRELLIS_DB_PATH = path.join(dir, "data.db");
const sqlite = await import("./sqlite");
sqlite.resetDBForTests();

const { DbWriteError, setDbFaultForTests } = await import("./db-error");
const {
  appendNodeResponse,
  createBranchNode,
  createSessionWithRoot,
  finalizeNode,
  getNode,
  getSessionNodes,
  markNodeInterrupted,
} = await import("./repo");
const { startRun, subscribe, hasLiveRun } = await import("./run-bus");
import type { RunEvent, CatchupEvent } from "./run-bus";

afterEach(() => setDbFaultForTests(null));
afterAll(() => {
  setDbFaultForTests(null);
  sqlite.resetDBForTests();
  if (previous === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = previous;
  rmSync(dir, { recursive: true, force: true });
});

const FULL = { code: "SQLITE_FULL", message: "SQLITE_FULL: database or disk is full" };

function seedSession(id: string): void {
  createSessionWithRoot({
    sessionId: id,
    nodeId: `${id}-root`,
    title: "t",
    question: "根问题",
    now: Date.now(),
    mode: "chat",
  });
}

/** 把一次 run 跑完，收集广播事件。 */
async function runToEnd(
  nodeId: string,
  events: ProviderEventLike[],
): Promise<(RunEvent | CatchupEvent)[]> {
  const seen: (RunEvent | CatchupEvent)[] = [];
  const done = new Promise<void>((resolve) => {
    startRun({
      nodeId,
      resumeFamily: "mock",
      // eslint-disable-next-line require-yield
      factory: async function* () {
        for (const e of events) yield e as never;
      },
    });
    const un = subscribe(nodeId, {
      onEvent: (e) => seen.push(e),
      onClose: () => resolve(),
    });
    if (!un) resolve();
  });
  await done;
  // run-bus 的收尾里有几个 await（topic/对账），让它们跑完再断言 DB。
  await Bun.sleep(30);
  return seen;
}

type ProviderEventLike =
  | { type: "delta"; text: string }
  | { type: "done"; usage?: { input: number; output: number; cacheRead: number; cacheCreation: number } };

// ---------------------------------------------------------------------------
// ① repo 层：写失败抛 DbWriteError（不是被吞掉的 undefined）
// ---------------------------------------------------------------------------

test("建行写失败抛 DbWriteError，且不留半截数据（事务回滚）", () => {
  seedSession("s-create");
  setDbFaultForTests(FULL);
  let caught: InstanceType<typeof DbWriteError> | null = null;
  try {
    createBranchNode({
      nodeId: "never-born",
      parentId: "s-create-root",
      question: "磁盘满的时候提的问",
      parentAnchor: null,
      now: Date.now(),
    });
  } catch (e) {
    caught = e as InstanceType<typeof DbWriteError>;
  }
  setDbFaultForTests(null);
  expect(caught).toBeInstanceOf(DbWriteError);
  expect(caught!.kind).toBe("full");
  expect(caught!.userMessage).toContain("磁盘");
  // 半截 turn 检查：节点没建出来，会话里只剩 root
  expect(getNode("never-born")).toBeNull();
  expect(getSessionNodes("s-create")).toHaveLength(1);
});

test("流式增量写失败同样抛错（旧代码这里是空 catch）", () => {
  seedSession("s-append");
  setDbFaultForTests(FULL);
  expect(() => appendNodeResponse("s-append-root", "x")).toThrow(DbWriteError);
});

test("SQLITE_BUSY 会重试；只失败一次时调用方完全无感", () => {
  seedSession("s-busy");
  setDbFaultForTests({ code: "SQLITE_BUSY", message: "database is locked", times: 1 });
  appendNodeResponse("s-busy-root", "撑过去了");
  expect(getNode("s-busy-root")?.response).toBe("撑过去了");
});

// ---------------------------------------------------------------------------
// ② run-bus 层：写失败 → 明确 error 事件 + 节点落 error，没有残留 streaming
// ---------------------------------------------------------------------------

test("落库失败时 run 立刻停、广播人话错误、节点落 error，无残留 streaming", async () => {
  seedSession("s-run");
  const nodeId = "s-run-node";
  createBranchNode({
    nodeId,
    parentId: "s-run-root",
    question: "会在磁盘满的时候回答",
    parentAnchor: null,
    now: Date.now(),
  });
  expect(getNode(nodeId)?.status).toBe("streaming");

  // 前两次写（delta）失败，之后恢复 —— 模拟事故里「瞬时 FULL，事后自愈」。
  // 恢复之后 run-bus 的兜底收尸才写得进去，这正是要验证的补救链路。
  setDbFaultForTests({ ...FULL, times: 2 });
  const seen = await runToEnd(nodeId, [
    { type: "delta", text: "第一段" },
    { type: "delta", text: "第二段" },
    { type: "done", usage: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 } },
  ]);

  const errors = seen.filter((e) => e.type === "error") as { type: "error"; message: string }[];
  expect(errors.length).toBeGreaterThan(0);
  expect(errors[0].message).toContain("磁盘");
  expect(errors[0].message).toContain("数据库写入失败");
  // 不许假装成功
  expect(seen.some((e) => e.type === "done")).toBeFalse();
  // 也不该把失败的那段字广播出去（广播了就等于骗用户说存下了）
  expect(seen.some((e) => e.type === "delta")).toBeFalse();

  const node = getNode(nodeId)!;
  expect(node.status).toBe("error");
  expect(node.errorMessage).toContain("磁盘");
  expect(hasLiveRun(nodeId)).toBeFalse();
  // 这一棵树上没有任何回答节点还挂在 streaming（root 是 fixture，从没跑过 run）
  expect(
    getSessionNodes("s-run").filter(
      (n) => n.status === "streaming" && n.id !== "s-run-root",
    ),
  ).toHaveLength(0);
});

test("一切正常时不受影响（基线：done 照常广播、节点落 done）", async () => {
  seedSession("s-ok");
  const nodeId = "s-ok-node";
  createBranchNode({
    nodeId,
    parentId: "s-ok-root",
    question: "正常一轮",
    parentAnchor: null,
    now: Date.now(),
  });
  const seen = await runToEnd(nodeId, [
    { type: "delta", text: "正文" },
    { type: "done", usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } },
  ]);
  expect(seen.some((e) => e.type === "done")).toBeTrue();
  expect(seen.some((e) => e.type === "error")).toBeFalse();
  const node = getNode(nodeId)!;
  expect(node.status).toBe("done");
  expect(node.response).toBe("正文");
});

test("只有终态那一次写失败：不假装 done，节点落 error 而不是留 streaming", async () => {
  seedSession("s-final");
  const nodeId = "s-final-node";
  createBranchNode({
    nodeId,
    parentId: "s-final-root",
    question: "回答生成完了但终态写不进去",
    parentAnchor: null,
    now: Date.now(),
  });
  // 事件里没有 delta，于是这一轮的第一次 DB 写就是 finalizeNode —— 注入一次
  // FULL 精确命中它；随后的兜底收尸（markNodeInterrupted）落在故障窗口之外。
  setDbFaultForTests({ ...FULL, times: 1 });
  const seen = await runToEnd(nodeId, [
    { type: "done", usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } },
  ]);
  const errors = seen.filter((e) => e.type === "error") as { message: string }[];
  expect(errors).toHaveLength(1);
  expect(errors[0].message).toContain("磁盘");
  expect(seen.some((e) => e.type === "done")).toBeFalse();
  const node = getNode(nodeId)!;
  expect(node.status).toBe("error");
  expect(node.errorMessage).toContain("磁盘");
});

test("SQLITE_FULL 时终态写不进去 → 节点不会永远 streaming（重连补写收尸）", () => {
  seedSession("s-reap");
  const nodeId = "s-reap-node";
  createBranchNode({
    nodeId,
    parentId: "s-reap-root",
    question: "进程被卡在中途",
    parentAnchor: null,
    now: Date.now(),
  });
  // 模拟「finalize 那一刻磁盘还是满的，兜底也没写进去」的最坏情况
  setDbFaultForTests(FULL);
  expect(() =>
    finalizeNode({
      nodeId,
      status: "done",
      tokenInput: 0,
      tokenOutput: 0,
      tokenCacheRead: 0,
      tokenCacheCreation: 0,
      now: Date.now(),
    }),
  ).toThrow(DbWriteError);
  expect(getNode(nodeId)?.status).toBe("streaming"); // 事故现场：转圈的那一行
  setDbFaultForTests(null);

  // 磁盘恢复后，重连端点 / 开机 reap 走的同一个判据把它收成 error
  expect(markNodeInterrupted(nodeId, "数据库写入失败：磁盘空间不足")).toBeTrue();
  const node = getNode(nodeId)!;
  expect(node.status).toBe("error");
  expect(node.errorMessage).toContain("磁盘");
  // 幂等：已经是终态就不再改
  expect(markNodeInterrupted(nodeId)).toBeFalse();
});

// ---------------------------------------------------------------------------
// ③ API 层：POST /api/chat 回明确错误（而不是把请求挂住 / 只给个状态码）
// ---------------------------------------------------------------------------

test("POST /api/chat 建行遇 SQLITE_FULL → 507 + 人话 error 字段 + 错误码", async () => {
  const { POST } = await import("@/app/api/chat/route");
  setDbFaultForTests(FULL);
  const res = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "root",
        question: "磁盘满的时候提问",
        provider: "mock",
        mode: "chat",
      }),
    }),
  );
  setDbFaultForTests(null);
  expect(res.status).toBe(507); // Insufficient Storage：监控能和普通 500 分开
  const body = (await res.json()) as { error: string; code: string };
  expect(body.code).toBe("SQLITE_FULL");
  expect(body.error).toContain("磁盘");
  expect(body.error).toContain("数据库写入失败");
  expect(body.error).toContain("重试");
  // 不是 SSE：请求当场结束，前端不会挂在那儿等永远不来的事件
  expect(res.headers.get("content-type")).toContain("application/json");
});

test("markNodeInterrupted 不碰 Agent daemon 驱动的节点（与开机 reap 同判据）", () => {
  seedSession("s-as");
  const nodeId = "s-as-node";
  createBranchNode({
    nodeId,
    parentId: "s-as-root",
    question: "这一轮归 AS 管",
    parentAnchor: null,
    now: Date.now(),
  });
  const db = sqlite.getDB();
  db.prepare(
    "INSERT INTO as_threads(thread_id, daemon_id, session_id, created_at) VALUES (?,?,?,?)",
  ).run("thread-1", "daemon-1", "s-as", Date.now());
  db.prepare(
    `INSERT INTO as_turns(node_id, thread_id, daemon_id, turn_id, client_turn_id, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(nodeId, "thread-1", "daemon-1", "turn-1", "client-1", Date.now());
  expect(markNodeInterrupted(nodeId)).toBeFalse();
  expect(getNode(nodeId)?.status).toBe("streaming");
});
