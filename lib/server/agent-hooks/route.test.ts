import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

mock.module("server-only", () => ({}));

const testDir = mkdtempSync(path.join(tmpdir(), "trellis-hook-route-"));
process.env.TRELLIS_DB_PATH = path.join(testDir, "hooks.db");
process.env.TRELLIS_HOOK_DIR = testDir;

const TOKEN = "test-token-0123456789";
writeFileSync(
  path.join(testDir, "endpoint.env"),
  `TRELLIS_HOOK_PORT=3088\nTRELLIS_HOOK_TOKEN=${TOKEN}\n`,
);

// bun test 一个进程跑所有文件，sqlite 的连接是跨文件共享的 singleton；
// 别的测试文件可能已经开过（别的 path）或关掉了它。见 sqlite.ts:resetDBForTests。
const sqlite = await import("../sqlite");
sqlite.resetDBForTests();

const hookRoute = await import("../../../app/api/hooks/claude/route");
const stateRoute = await import("../../../app/api/hooks/state/route");
const oneStateRoute = await import("../../../app/api/hooks/state/[sessionId]/route");
const store = await import("./store");

afterAll(() => {
  sqlite.resetDBForTests();
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.TRELLIS_HOOK_DIR;
});

function post(
  payload: unknown,
  { token = TOKEN, paneKey = "pane-1" }: { token?: string | null; paneKey?: string } = {},
): Promise<Response> {
  const form = new FormData();
  form.set("paneKey", paneKey);
  form.set("payload", typeof payload === "string" ? payload : JSON.stringify(payload));
  const headers: Record<string, string> = {};
  if (token !== null) headers["x-trellis-hook-token"] = token;
  return hookRoute.POST(
    new Request("http://127.0.0.1/api/hooks/claude", {
      method: "POST",
      headers,
      body: form,
    }),
  );
}

describe("POST /api/hooks/claude 的 token 校验", () => {
  test("缺 header → 401", async () => {
    const r = await post({ hook_event_name: "SessionStart", session_id: "x" }, { token: null });
    expect(r.status).toBe(401);
  });

  test("错 token → 401，且什么都不落库", async () => {
    const r = await post(
      { hook_event_name: "SessionStart", session_id: "never-stored" },
      { token: "wrong-token-0123456789" },
    );
    expect(r.status).toBe(401);
    expect(store.getHookRecord("never-stored")).toBeNull();
  });

  test("长度不同的 token 也是干净的 401（不抛）", async () => {
    const r = await post({ hook_event_name: "SessionStart", session_id: "x" }, { token: "ab" });
    expect(r.status).toBe(401);
  });

  test("对 token → 200", async () => {
    const r = await post({ hook_event_name: "SessionStart", session_id: "ok-1" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, sessionId: "ok-1", state: "working" });
  });
});

describe("POST /api/hooks/claude 的载荷", () => {
  test("payload 不是 JSON → 400", async () => {
    const r = await post("{ 坏 json");
    expect(r.status).toBe(400);
  });

  test("没有 session_id 的事件被认账但忽略", async () => {
    const r = await post({ hook_event_name: "Stop" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, ignored: "no session_id" });
  });
});

describe("落库与读取", () => {
  test("一串事件跑完后状态、卡片、paneKey 都在库里", async () => {
    const sid = "flow-1";
    await post({ hook_event_name: "SessionStart", session_id: sid, cwd: "/repo" });
    await post({
      hook_event_name: "UserPromptSubmit",
      session_id: sid,
      prompt: "跑一下测试",
    });
    await post({
      hook_event_name: "PreToolUse",
      session_id: sid,
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "哪个？" }] },
    });

    const rec = store.getHookRecord(sid)!;
    expect(rec.state).toBe("waiting");
    expect(rec.paneKey).toBe("pane-1");
    expect(rec.cwd).toBe("/repo");
    expect(rec.prompt).toBe("跑一下测试");
    expect(rec.interactivePrompt).toEqual({ questions: [{ question: "哪个？" }] });

    // 撤卡后回 working —— JSON 列的 null 也要正确读回来
    await post({
      hook_event_name: "PostToolUse",
      session_id: sid,
      tool_name: "AskUserQuestion",
    });
    const after = store.getHookRecord(sid)!;
    expect(after.state).toBe("working");
    expect(after.interactivePrompt).toBeNull();
  });

  test("子 agent 名单与 stash 跨请求持久化", async () => {
    const sid = "flow-sub";
    await post({ hook_event_name: "SessionStart", session_id: sid });
    await post({ hook_event_name: "PreToolUse", session_id: sid, tool_name: "Bash", tool_input: { command: "ls" } });
    await post({ hook_event_name: "SubagentStart", session_id: sid, agent_type: "Explore" });
    expect(store.getHookRecord(sid)!.subagents).toEqual(["Explore"]);

    await post({
      hook_event_name: "PermissionRequest",
      session_id: sid,
      tool_name: "Bash",
      summary: "跑 rm",
    });
    const waiting = store.getHookRecord(sid)!;
    expect(waiting.state).toBe("waiting");
    expect(waiting.stashed?.state).toBe("working");

    await post({ hook_event_name: "SubagentStop", session_id: sid, agent_type: "Explore" });
    const restored = store.getHookRecord(sid)!;
    expect(restored.state).toBe("working");
    expect(restored.toolName).toBe("Bash");
    expect(restored.stashed).toBeNull();
  });

  test("GET /api/hooks/state 列全部，[sessionId] 取单条 / 404", async () => {
    const all = (await (await stateRoute.GET()).json()) as {
      records: { sessionId: string }[];
    };
    expect(all.records.map((r) => r.sessionId)).toContain("flow-1");

    const one = await oneStateRoute.GET(new Request("http://127.0.0.1/"), {
      params: Promise.resolve({ sessionId: "flow-1" }),
    });
    expect(one.status).toBe(200);
    expect((await one.json()).record.sessionId).toBe("flow-1");

    const missing = await oneStateRoute.GET(new Request("http://127.0.0.1/"), {
      params: Promise.resolve({ sessionId: "nope" }),
    });
    expect(missing.status).toBe(404);
  });
});

describe("端点文件没写时这个口是关的", () => {
  test("读不到 token → 503", async () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "trellis-hook-empty-"));
    const saved = process.env.TRELLIS_HOOK_DIR;
    process.env.TRELLIS_HOOK_DIR = emptyDir;
    try {
      const r = await post({ hook_event_name: "SessionStart", session_id: "x" });
      expect(r.status).toBe(503);
    } finally {
      process.env.TRELLIS_HOOK_DIR = saved;
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
