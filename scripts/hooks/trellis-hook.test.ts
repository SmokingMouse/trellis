import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("hook script uses the real Herdr pane id unless explicitly overridden", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-hook-wire-"));
  const received: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const form = await req.formData();
    received.push(String(form.get("paneKey")));
    expect(JSON.parse(String(form.get("payload"))).session_id).toBe("wire-test");
    return Response.json({ ok: true });
  } });
  try {
    const endpoint = path.join(dir, "endpoint.env");
    fs.writeFileSync(endpoint, `TRELLIS_HOOK_PORT=${server.port}\nTRELLIS_HOOK_TOKEN=local-test\n`);
    for (const [override, herdr, expected] of [["", "w1:p1", "w1:p1"], ["custom", "w1:p1", "custom"], ["", "", ""]]) {
      const child = Bun.spawn(["sh", path.join(import.meta.dir, "trellis-hook.sh")], {
        env: { ...process.env, TRELLIS_HOOK_ENDPOINT: endpoint, TRELLIS_PANE_KEY: override, HERDR_PANE_ID: herdr },
        stdin: new Blob([JSON.stringify({ hook_event_name: "SessionStart", session_id: "wire-test" })]), stdout: "ignore", stderr: "pipe",
      });
      expect(await child.exited).toBe(0);
      expect(received.at(-1)).toBe(expected);
    }
    expect(received).toHaveLength(3);
  } finally {
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 阻塞模式（--block）：假 Trellis 驱动真实脚本 -------------------------------

const SCRIPT = path.join(import.meta.dir, "trellis-hook.sh");
// Claude Code 2.1.280 喂给 hook 的真实形状（PreToolUse(AskUserQuestion)）
const ASK_STDIN = {
  session_id: "0f8f7c2e-blocking",
  transcript_path: "/Users/x/.claude/projects/-tmp/0f8f7c2e-blocking.jsonl",
  cwd: "/tmp",
  permission_mode: "default",
  hook_event_name: "PreToolUse",
  tool_name: "AskUserQuestion",
  tool_input: { questions: [{ question: "Which color?", header: "Color", multiSelect: false, options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }] }] },
  tool_use_id: "toolu_01BLOCK",
};
const DONE_JSON = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...ASK_STDIN.tool_input, answers: { "Which color?": "Blue" } } } };

type Hit = { path: string; attempt: string; wait: string; paneKey: string; token: string | null };

async function runBlocking(
  respond: (hit: Hit, n: number) => Response | Promise<Response>,
  env: Record<string, string> = {},
  args: string[] = ["--block"],
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-hook-block-"));
  const hits: Hit[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(req) {
    const form = await req.formData();
    const hit: Hit = {
      path: new URL(req.url).pathname,
      attempt: String(form.get("attempt") ?? ""),
      wait: String(form.get("wait") ?? ""),
      paneKey: String(form.get("paneKey") ?? ""),
      token: req.headers.get("x-trellis-hook-token"),
    };
    expect(JSON.parse(String(form.get("payload")))).toEqual(ASK_STDIN);
    hits.push(hit);
    return respond(hit, hits.length);
  } });
  const { PORT_OVERRIDE, ...childEnv } = env;
  const endpoint = path.join(dir, "endpoint.env");
  fs.writeFileSync(endpoint, `TRELLIS_HOOK_PORT=${PORT_OVERRIDE ?? server.port}\nTRELLIS_HOOK_TOKEN=tok-1\n`);
  const t0 = Date.now();
  try {
    const child = Bun.spawn(["sh", SCRIPT, ...args], {
      env: { ...process.env, TRELLIS_HOOK_ENDPOINT: endpoint, HERDR_PANE_ID: "w9:p9", TRELLIS_PANE_KEY: "", TRELLIS_HOOK_SEGMENT: "1", ...childEnv },
      stdin: new Blob([JSON.stringify(ASK_STDIN)]), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    return { code, stdout, hits, ms: Date.now() - t0 };
  } finally {
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const text = (s: string, status = 200) => new Response(s, { status, headers: { "Content-Type": "text/plain" } });

test("--block：pending 两段后拿到作答 → stdout 是 hook JSON、exit 0、attempt 每段相同", async () => {
  const r = await runBlocking((_hit, n) => n < 3 ? text("pending\n") : text(`done\n${JSON.stringify(DONE_JSON)}\n`));
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual(DONE_JSON);
  expect(r.hits).toHaveLength(3);
  expect(r.hits.every((h) => h.path === "/api/hooks/claude/interaction" && h.token === "tok-1" && h.paneKey === "w9:p9")).toBe(true);
  // 首段不挂（立刻确认连上），之后按段长挂
  expect(r.hits.map((h) => h.wait)).toEqual(["0", "1", "1"]);
  expect(new Set(r.hits.map((h) => h.attempt)).size).toBe(1);
  expect(r.hits[0].attempt).toMatch(/^\d+-\d+-[0-9a-f]+$/);
});

test("--block：pass（交给终端 / 过期 / 不阻塞）→ 无输出 exit 0", async () => {
  const r = await runBlocking(() => text("pass\n"));
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("");
  expect(r.hits).toHaveLength(1);
});

test("--block：一开始就连不上 Trellis → 立即无输出退出", async () => {
  // 端点文件指向一个没人监听的端口
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const dead = String(probe.port);
  probe.stop(true);
  const r = await runBlocking(() => text("pending\n"), { PORT_OVERRIDE: dead });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("");
  expect(r.hits).toHaveLength(0);
  expect(r.ms).toBeLessThan(3000);
});

test("--block：首段就 5xx（维护页）→ 当作连不上，无输出退出", async () => {
  const r = await runBlocking(() => text("maintenance", 503));
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("");
  expect(r.hits).toHaveLength(1);
});

test("--block：连上后 Trellis 重启（几段 503）→ 重连窗口内恢复并拿到同一个交互的答案", async () => {
  const r = await runBlocking(
    (_hit, n) => n === 1 ? text("pending\n") : n <= 3 ? text("restarting", 503) : text(`done\n${JSON.stringify(DONE_JSON)}\n`),
    { TRELLIS_HOOK_RESUME: "10" },
  );
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual(DONE_JSON);
  expect(r.hits).toHaveLength(4);
  expect(new Set(r.hits.map((h) => h.attempt)).size).toBe(1);
}, 15_000);

test("--block：断线超过重连窗口 → 放手（无输出）", async () => {
  const r = await runBlocking((_hit, n) => n === 1 ? text("pending\n") : text("down", 502), { TRELLIS_HOOK_RESUME: "2" });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("");
  expect(r.ms).toBeLessThan(6000);
}, 10_000);

test("--block：等满 TRELLIS_HOOK_WAIT_MAX 仍没人答 → 无输出退出", async () => {
  const r = await runBlocking(() => text("pending\n"), { TRELLIS_HOOK_WAIT_MAX: "2" });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("");
  expect(r.ms).toBeLessThan(5000);
}, 10_000);

test("观测快路径不变：不带 --block 只打 /api/hooks/claude、无输出、慢服务也在 ~1.5s 内退出", async () => {
  const r = await runBlocking(async () => {
    await Bun.sleep(4000);
    return Response.json({ ok: true });
  }, {}, []);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("");
  expect(r.hits.map((h) => h.path)).toEqual(["/api/hooks/claude"]);
  expect(r.ms).toBeLessThan(2500);
}, 10_000);
