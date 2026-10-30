import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

mock.module("server-only", () => ({}));

const testDir = mkdtempSync(path.join(tmpdir(), "trellis-hook-ix-"));
process.env.TRELLIS_DB_PATH = path.join(testDir, "ix.db");
process.env.TRELLIS_HOOK_DIR = testDir;
const TOKEN = "ix-token-0123456789";
writeFileSync(path.join(testDir, "endpoint.env"), `TRELLIS_HOOK_PORT=3088\nTRELLIS_HOOK_TOKEN=${TOKEN}\n`);

const sqlite = await import("../sqlite");
sqlite.resetDBForTests();

const pollRoute = await import("../../../app/api/hooks/claude/interaction/route");
const hookRoute = await import("../../../app/api/hooks/claude/route");
const answerRoute = await import("../../../app/api/herdr/interactions/[id]/route");
const ix = await import("./interactions");
const store = await import("./store");
const core = await import("./interaction-core");

afterAll(() => {
  sqlite.resetDBForTests();
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.TRELLIS_HOOK_DIR;
});

beforeEach(() => {
  sqlite.getDB().exec("DELETE FROM agent_hook_interaction; DELETE FROM agent_hook_state;");
});

let seq = 0;
function ask(over: Record<string, unknown> = {}) {
  seq++;
  return {
    session_id: `s-${seq}`,
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: `toolu_${seq}`,
    cwd: "/tmp",
    tool_input: { questions: [{ question: "Which color?", header: "Color", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] }] },
    ...over,
  };
}
function permission(over: Record<string, unknown> = {}) {
  seq++;
  return {
    session_id: `s-${seq}`,
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "make deploy" },
    ...over,
  };
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function poll(payload: unknown, opts: { wait?: number; attempt?: string; token?: string | null; signal?: AbortSignal } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token !== null) headers["x-trellis-hook-token"] = opts.token ?? TOKEN;
  const res = await pollRoute.POST(new Request("http://127.0.0.1/api/hooks/claude/interaction", {
    method: "POST",
    headers,
    body: form({ payload: JSON.stringify(payload), paneKey: "w1:p1", wait: String(opts.wait ?? 0), ...(opts.attempt ? { attempt: opts.attempt } : {}) }),
    signal: opts.signal,
  }));
  const text = await res.text();
  const [line, ...rest] = text.replace(/\n$/, "").split("\n");
  return { status: res.status, line, body: rest.join("\n") };
}

async function answer(id: string, body: unknown) {
  const res = await answerRoute.POST(
    new Request(`http://127.0.0.1/api/herdr/interactions/${id}`, { method: "POST", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function observe(payload: unknown) {
  return hookRoute.POST(new Request("http://127.0.0.1/api/hooks/claude", {
    method: "POST",
    headers: { "x-trellis-hook-token": TOKEN },
    body: form({ payload: JSON.stringify(payload), paneKey: "w1:p1" }),
  }));
}

function summaryOf(sessionId: string) {
  return store.listHookSummaries().find((r) => r.sessionId === sessionId);
}

describe("长轮询路由", () => {
  test("口令错 → 401，什么都不建", async () => {
    const p = ask();
    expect((await poll(p, { token: "nope" })).status).toBe(401);
    expect((await poll(p, { token: null })).status).toBe(401);
    expect(ix.getInteraction(core.interactionId(p))).toBeNull();
  });

  test("非阻塞事件 → pass，不建行", async () => {
    const p = ask({ tool_name: "Bash" });
    expect((await poll(p)).line).toBe("pass");
    expect(ix.getInteraction(core.interactionId(p))).toBeNull();
  });

  test("首段 pending → 摘要带 blocking、会话补记成 waiting → 作答 → 下一段 done + hook JSON", async () => {
    const p = ask();
    expect((await poll(p)).line).toBe("pending");
    const id = core.interactionId(p);
    const sum = summaryOf(p.session_id);
    expect(sum?.state).toBe("waiting"); // 没有观测 hook 先到，也补记了
    expect(sum?.blocking).toMatchObject({ id, kind: "question", status: "pending", connected: true, toolUseId: p.tool_use_id });
    expect(sum?.blocking?.questions).toHaveLength(1);

    const r = await answer(id, { action: "answer", answer: { type: "answers", answers: { "Which color?": "Blue" } } });
    expect(r).toEqual({ status: 200, json: { ok: true, connected: true } });
    expect(summaryOf(p.session_id)?.blocking?.status).toBe("resolved");

    const done = await poll(p);
    expect(done.line).toBe("done");
    expect(JSON.parse(done.body)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "已在 Trellis 作答",
        updatedInput: { ...p.tool_input, answers: { "Which color?": "Blue" } },
      },
    });
    // 重复作答 → 409
    expect((await answer(id, { action: "answer", answer: { type: "answers", answers: { "Which color?": "Red" } } })).status).toBe(409);
  });

  test("挂着的那段被作答立刻叫醒（不等满 wait）", async () => {
    const p = ask();
    expect((await poll(p)).line).toBe("pending");
    const t0 = Date.now();
    const pending = poll(p, { wait: 20 });
    await Bun.sleep(50);
    await answer(core.interactionId(p), { action: "answer", answer: { type: "answers", answers: { "Which color?": "Red" } } });
    const r = await pending;
    expect(r.line).toBe("done");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test("作答对不上题目 → 400；交互不存在 → 404；id 格式不对 → 400", async () => {
    const p = ask();
    await poll(p);
    const id = core.interactionId(p);
    expect((await answer(id, { action: "answer", answer: { type: "answers", answers: { other: "x" } } })).status).toBe(400);
    expect((await answer("ix_00000000000000000000", { action: "handoff" })).status).toBe(404);
    expect((await answer("../etc", { action: "handoff" })).status).toBe(400);
  });

  test("交给终端 → 下一段 pass（脚本无输出退出），摘要里消失", async () => {
    const p = permission();
    const attempt = "a-1";
    expect((await poll(p, { attempt })).line).toBe("pending");
    const id = core.interactionId(p, attempt);
    expect(summaryOf(p.session_id)?.blocking?.kind).toBe("permission");
    expect((await answer(id, { action: "handoff" })).status).toBe(200);
    expect((await poll(p, { attempt })).line).toBe("pass");
    expect(summaryOf(p.session_id)?.blocking).toBeUndefined();
  });

  test("30 分钟没人答 → expired → pass", async () => {
    const p = ask();
    await poll(p);
    const id = core.interactionId(p);
    sqlite.getDB().prepare("UPDATE agent_hook_interaction SET created_at = ? WHERE id = ?").run(Date.now() - core.INTERACTION_TTL_MS - 1, id);
    expect((await poll(p)).line).toBe("pass");
    expect(ix.getInteraction(id)?.status).toBe("expired");
  });
});

describe("断线重连 / trellis 重启", () => {
  test("重启（DB 重开、进程内唤醒表清空）后同一个 hook 重连拿到同一个交互和期间的答案", async () => {
    const p = permission();
    const attempt = "proc-42";
    expect((await poll(p, { attempt })).line).toBe("pending");
    const id = core.interactionId(p, attempt);

    // 模拟重启：断开 DB 连接、丢掉内存态
    sqlite.resetDBForTests();
    (globalThis as { __trellisHookIxWaiters?: unknown }).__trellisHookIxWaiters = undefined;

    // 重连那段：同 attempt → 同 id，仍是 pending，且没有建第二行
    expect((await poll(p, { attempt })).line).toBe("pending");
    expect(sqlite.getDB().prepare("SELECT COUNT(*) AS n FROM agent_hook_interaction").get()).toEqual({ n: 1 });

    expect((await answer(id, { action: "answer", answer: { type: "permission", allow: true, always: true } })).status).toBe(200);
    sqlite.resetDBForTests();
    const done = await poll(p, { attempt });
    expect(done.line).toBe("done");
    const out = JSON.parse(done.body);
    expect(out.hookSpecificOutput.decision.behavior).toBe("allow");
    expect(out.hookSpecificOutput.decision.updatedPermissions[0]).toMatchObject({ type: "addRules", destination: "session" });
  });

  test("新的 hook 进程跑同一条命令（新 attempt）→ 新交互，不会拿走上一次的允许", async () => {
    const p = permission();
    await poll(p, { attempt: "first" });
    await answer(core.interactionId(p, "first"), { action: "answer", answer: { type: "permission", allow: true } });
    expect((await poll(p, { attempt: "first" })).line).toBe("done");
    expect((await poll(p, { attempt: "second" })).line).toBe("pending");
  });

  test("hook 断开超过 3 分钟：摘要不再给、作答 409", async () => {
    const p = ask();
    await poll(p);
    const id = core.interactionId(p);
    sqlite.getDB().prepare("UPDATE agent_hook_interaction SET last_seen_at = ? WHERE id = ?").run(Date.now() - core.INTERACTION_DETACH_GRACE_MS - 1, id);
    expect(summaryOf(p.session_id)?.blocking).toBeUndefined();
    expect((await answer(id, { action: "handoff" })).status).toBe(409);
  });

  test("断开 3 分钟内：摘要仍给、标 connected=false 超过 40s", async () => {
    const p = ask();
    await poll(p);
    const id = core.interactionId(p);
    sqlite.getDB().prepare("UPDATE agent_hook_interaction SET last_seen_at = ? WHERE id = ?").run(Date.now() - 60_000, id);
    expect(summaryOf(p.session_id)?.blocking).toMatchObject({ id, connected: false });
  });
});

describe("观测 hook 的后续事件收尾", () => {
  test("PostToolUse 同一个 tool_use_id → 作废；别的调用跑完不影响", async () => {
    const p = ask();
    await poll(p);
    const id = core.interactionId(p);
    await observe({ session_id: p.session_id, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_other", tool_input: {} });
    expect(ix.getInteraction(id)?.status).toBe("pending");
    await observe({ session_id: p.session_id, hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_use_id: p.tool_use_id, tool_input: p.tool_input });
    expect(ix.getInteraction(id)?.status).toBe("cancelled");
    expect((await poll(p)).line).toBe("pass");
  });

  test("授权卡（无 tool_use_id）：并行的别的工具跑完不带走，同命令的 PostToolUse 才作废", async () => {
    const p = permission();
    await poll(p, { attempt: "x" });
    const id = core.interactionId(p, "x");
    await observe({ session_id: p.session_id, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" } });
    expect(ix.getInteraction(id)?.status).toBe("pending");
    await observe({ session_id: p.session_id, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t2", tool_input: { command: "make deploy" } });
    expect(ix.getInteraction(id)?.status).toBe("cancelled");
  });

  test("Stop / UserPromptSubmit（电脑上 Esc 掉之后）→ 全部作废", async () => {
    const p = ask();
    await poll(p);
    await observe({ session_id: p.session_id, hook_event_name: "UserPromptSubmit", prompt: "算了" });
    expect(ix.getInteraction(core.interactionId(p))?.status).toBe("cancelled");
  });

  test("观测路由的应答形状不变", async () => {
    const r = await observe({ session_id: "obs-1", hook_event_name: "SessionStart" });
    expect(await r.json()).toMatchObject({ ok: true, sessionId: "obs-1", state: "working" });
  });
});

describe("计划审批端到端", () => {
  test("批准并自动接受编辑 → setMode acceptEdits + updatedInput", async () => {
    seq++;
    const p = { session_id: `s-${seq}`, hook_event_name: "PermissionRequest", tool_name: "ExitPlanMode", tool_input: { plan: "# P", planFilePath: "/tmp/p.md" } };
    await poll(p, { attempt: "plan-1" });
    const sum = summaryOf(p.session_id)?.blocking;
    expect(sum).toMatchObject({ kind: "plan", plan: "# P" });
    expect((await answer(sum!.id, { action: "answer", answer: { type: "plan", approve: true, mode: "acceptEdits" } })).status).toBe(200);
    const done = await poll(p, { attempt: "plan-1" });
    expect(JSON.parse(done.body)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedInput: { plan: "# P", planFilePath: "/tmp/p.md" },
          updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
        },
      },
    });
  });
});
