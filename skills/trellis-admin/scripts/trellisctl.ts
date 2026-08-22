#!/usr/bin/env bun
// trellisctl —— Trellis 后台配置的命令行入口（agents / tasks / triggers / runs）。
//
// 为什么是一个脚本而不是让模型裸 curl：
//  ① base URL 与凭证的发现有三层降级，收敛在一处比每次现推靠谱；
//  ② 列表接口把 systemPrompt / prompt 全文吐回来，裸 curl 一次就吃掉几千 token ——
//     这里默认只打关键字段，要全文才 `--json`；
//  ③ 「挂触发器」是唯一让任务开始自动跑的动作，那道最小间隔闸只能长在这里。
//
// 读操作随便跑；写操作请先按 SKILL.md 的纪律把 payload 摘要给用户看过。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
// 与 lib/auth-cookie.ts 保持一致。刻意不 import —— 这个脚本要能在 Trellis 仓库
// 之外独立跑（终端里的 claude 会话也会用它）。
const AUTH_COOKIE = "trellis_auth";
// 触发间隔下限（分钟）。防的不是恶意，是手滑写出 `* * * * *` 烧一夜 token。
const MIN_GAP_MINUTES = 5;

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 连上哪个 Trellis
// ---------------------------------------------------------------------------

let _base: string | null = null;

async function probe(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/__gate/health`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return false;
    const j = (await r.json()) as { gate?: string };
    return j?.gate === "up";
  } catch {
    return false;
  }
}

/** 优先级：$TRELLIS_URL → $TRELLIS_PORT/$PORT（被 Trellis spawn 的子进程会继承）
 *  → 3088（server.ts 的默认大门端口）。每个候选都用 /__gate/health 真探一次，
 *  探不到就换下一个 —— 端口被别的东西占着时，静默打错地方比报错难查得多。 */
async function resolveBase(): Promise<string> {
  if (_base) return _base;
  if (process.env.TRELLIS_URL) {
    const u = process.env.TRELLIS_URL.replace(/\/$/, "");
    if (!(await probe(u))) die(`TRELLIS_URL=${u} 探不到（/__gate/health 没回 gate:up）`);
    return (_base = u);
  }
  const ports = [...new Set([Number(process.env.TRELLIS_PORT), Number(process.env.PORT), 3088])]
    .filter((p) => Number.isFinite(p) && p > 0);
  for (const p of ports) {
    const u = `http://127.0.0.1:${p}`;
    if (await probe(u)) return (_base = u);
  }
  die(
    `没找到在跑的 Trellis（试过端口 ${ports.join(" / ")}）。\n` +
      `  · 服务真的起着吗：curl -s http://127.0.0.1:3088/__gate/health\n` +
      `  · 端口不是 3088 就显式给：TRELLIS_URL=http://127.0.0.1:<port> trellisctl ...\n` +
      `  · 环境里有 http_proxy 时 fetch 可能被劫走，先 unset http_proxy https_proxy 再试`,
  );
}

/** 认证闸默认是关的（TRELLIS_AUTH_PASS 未设即全放行，见 proxy.ts:36）。开着的时候
 *  cookie 值就是 TRELLIS_AUTH_TOKEN，真源在 ~/.trellis/shared/.env.local。 */
function authToken(): string | null {
  if (process.env.TRELLIS_AUTH_TOKEN) return process.env.TRELLIS_AUTH_TOKEN;
  for (const p of [
    path.join(HOME, ".trellis/shared/.env.local"),
    path.join(HOME, ".trellis/current/.env.local"),
  ]) {
    try {
      const m = fs.readFileSync(p, "utf8").match(/^\s*TRELLIS_AUTH_TOKEN\s*=\s*(.+?)\s*$/m);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    } catch {
      /* 文件不在就试下一个 */
    }
  }
  return null;
}

type ApiResult = { status: number; body: any };

function authHeaders(hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  const tok = authToken();
  if (tok) headers.cookie = `${AUTH_COOKIE}=${tok}`;
  if (hasBody) headers["content-type"] = "application/json";
  return headers;
}

const AUTH_HINT =
  `401 —— 认证闸开着，但没拿到 token。\n` +
  `  真源：~/.trellis/shared/.env.local 里的 TRELLIS_AUTH_TOKEN\n` +
  `  或显式给：TRELLIS_AUTH_TOKEN=xxx trellisctl ...`;

async function api(
  method: string,
  p: string,
  body?: unknown,
  opts?: { tolerate?: number[] },
): Promise<ApiResult> {
  const base = await resolveBase();
  const r = await fetch(base + p, {
    method,
    headers: authHeaders(body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let j: any = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应，保留原文用于报错 */
  }
  if (r.status === 401) die(AUTH_HINT);
  // 202 是「排队中 / 上一次还在跑」，那是状态不是错误（见 tasks/[id]/run/route.ts）。
  // tolerate：个别语义化状态码不算错（如 abort 的 404 = 本来就没在跑）。
  if (!r.ok && r.status !== 202 && !opts?.tolerate?.includes(r.status)) {
    die(`${method} ${p} → ${r.status}: ${j?.error ?? text.slice(0, 400)}`);
  }
  return { status: r.status, body: j };
}

/** SSE 请求：返回原始 Response，交给 sseEvents() 逐事件消费。timeoutMs 是
 *  整条流的总时限 —— LLM 轮次动辄几分钟，超时不代表 run 死了（服务端
 *  run-bus 与 HTTP 解耦，断开只是不看了，run 继续跑、继续落库）。 */
async function apiSse(
  method: string,
  p: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<Response> {
  const base = await resolveBase();
  const r = await fetch(base + p, {
    method,
    headers: authHeaders(body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  if (r.status === 401) die(AUTH_HINT);
  if (!r.ok) {
    const text = await r.text();
    let j: any = null;
    try {
      j = text ? JSON.parse(text) : null;
    } catch {
      /* keep raw */
    }
    die(`${method} ${p} → ${r.status}: ${j?.error ?? text.slice(0, 400)}`);
  }
  return r;
}

/** 逐事件读 SSE（`data: {...}\n\n` 分帧）。 */
async function* sseEvents(r: Response): AsyncGenerator<any> {
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          yield JSON.parse(line.slice(5).trim());
        } catch {
          /* 非 JSON data 行（心跳等）直接丢 */
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const pos = argv.filter((a) => !a.startsWith("--"));
const has = (f: string) => flags.has(f);
function flagVal(name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
}

/** JSON 入参支持三种形态：内联串 / `@文件` / `-`（stdin）。
 *  prompt 里带引号和换行是常态，heredoc 走 stdin 才不会被 shell 转义搅烂。 */
function readJsonArg(raw: string | undefined): any {
  if (raw === undefined) die("缺少 JSON 参数（可用 '-' 从 stdin 读，或 @路径 从文件读）");
  let txt = raw;
  if (raw === "-") txt = fs.readFileSync(0, "utf8");
  else if (raw.startsWith("@")) txt = fs.readFileSync(raw.slice(1), "utf8");
  try {
    return JSON.parse(txt);
  } catch (e) {
    die(`JSON 解析失败：${(e as Error).message}`);
  }
}

const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));
const short = (id: string | null) => (id ? id.slice(0, 8) : "—");
function ts(ms: number | null | undefined): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function dur(a: number | null, b: number | null): string {
  if (!a || !b) return "—";
  const s = Math.round((b - a) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}
function clip(s: string, n: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
/** 列宽按**显示宽度**算：中日韩字符占两格，用 padEnd 直接数码点会让中文名把整列
 *  推歪，而这些列表存在的意义就是一眼扫过去。 */
function pad(s: string, n: number): string {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return s + " ".repeat(Math.max(1, n - w));
}

/** 复用仓库里的 lib/cron.ts（唯一实现，调度器用的就是它），而不是在这儿抄一份 ——
 *  抄一份就会漂移，而 cron 写错的症状是「静默不触发」，漂移到几周后才发现。
 *  脚本在 <repo>/skills/trellis-admin/scripts/ 下，上三级即仓库根。 */
async function cronLib(): Promise<any | null> {
  try {
    return await import(path.resolve(import.meta.dir, "../../..", "lib/cron.ts"));
  } catch {
    return null;
  }
}

/** 这条 cron 最密会隔多久触发一次（分钟）。只看分钟字段的间隔 —— 够用来挡住
 *  「每分钟」「每两分钟」这类，而它们正是「手滑烧一夜钱」的全部形态。 */
function minGapMinutes(fields: { minute: Set<number> }): number {
  const ms = [...fields.minute].sort((a, b) => a - b);
  if (ms.length <= 1) return 60;
  let gap = 60 - ms[ms.length - 1] + ms[0];
  for (let i = 1; i < ms.length; i++) gap = Math.min(gap, ms[i] - ms[i - 1]);
  return gap;
}

/** 纯文本参数三形态：字面 / `@文件` / `-`（stdin）。问题正文常带引号换行。 */
function readTextArg(raw: string | undefined, what: string): string {
  if (!raw) die(`缺少${what}（可内联，或 '-' 从 stdin 读、@路径 从文件读）`);
  let txt = raw;
  if (raw === "-") txt = fs.readFileSync(0, "utf8");
  else if (raw.startsWith("@")) txt = fs.readFileSync(raw.slice(1), "utf8");
  const t = txt.trim();
  if (!t) die(`${what}是空的`);
  return t;
}

function ktok(n: number | null | undefined): string {
  if (!n) return "0";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 距今多久（在跑的节点用它显示「跑了多久」）。 */
function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/** 长文默认打尾部 —— 消费方多半只要结论段，全文有 --full。 */
function tailLines(s: string, n: number): string {
  const lines = (s ?? "").split("\n");
  if (lines.length <= n) return s ?? "";
  return `…（前面还有 ${lines.length - n} 行，--full 看全文）\n${lines.slice(-n).join("\n")}`;
}

/** 节点状态一眼化：⏸ 在等人回答（比 streaming 更要紧，先判）。 */
function nodeIcon(n: { status: string; pendingInteraction?: unknown }): string {
  if (n.pendingInteraction) return "⏸";
  return n.status === "streaming" ? "▶" : n.status === "done" ? "✓" : n.status === "error" ? "✗" : "?";
}

/** 节点一行标签：主题 > 问题 > 引用来源。reference 节点没有问答语义。 */
function nodeLabel(n: any): string {
  if (n.kind === "reference") {
    return `◈ ${n.topicLabel || n.reference?.sourceUri || n.question || "引用材料"}`;
  }
  return n.topicLabel || n.question || "（空）";
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

async function cmdHealth() {
  const base = await resolveBase();
  const r = await fetch(`${base}/__gate/health`);
  const j = await r.json();
  console.log(`base: ${base}`);
  console.log(`token: ${authToken() ? "已拿到" : "没拿到（闸关着的话不影响）"}`);
  out(j);
}

async function cmdAgents(sub: string) {
  if (!sub || sub === "list") {
    const { body } = await api("GET", `/api/agents${has("--all") ? "?all=1" : ""}`);
    if (has("--json")) return out(body.agents);
    for (const a of body.agents) {
      const env = a.inheritEnv ? "继承本机" : "隔离";
      const tools = a.tools ? a.tools.join("/") : "全部工具";
      const skills = a.skills?.length ? ` skills=${a.skills.map((s: any) => s.name).join("/")}` : "";
      console.log(
        `${pad(a.slug, 20)} ${a.enabled ? " " : "停"} ${pad(clip(a.name, 16), 18)}` +
          `${pad(a.model ?? "跟随会话", 20)} ${pad(env, 9)} ${tools}${skills}`,
      );
    }
    // 刻意不打 id：slug 是稳定句柄，本脚本所有命令都收 slug；建任务时用
    // "agentSlug" 也会自动换成 id —— 没有任何场景需要人去复制那串 uuid。
    if (!has("--all")) console.log(`\n(只列了启用的，看全部加 --all)`);
    return;
  }
  if (sub === "get") {
    const a = await findAgent(pos[2]);
    return out(a ?? die(`没有这个 agent：${pos[2]}`));
  }
  if (sub === "create") {
    const payload = readJsonArg(pos[2]);
    if (!payload.slug || !payload.name) die("agent 至少要 { slug, name }");
    const { body } = await api("POST", "/api/agents", payload);
    console.log(`✓ 建好 agent ${body.agent.slug}（${short(body.agent.id)}）`);
    if (!body.agent.inheritEnv) {
      console.log(
        `  注意：inheritEnv 未开 = 隔离档 —— 它看不到本机 CLAUDE.md、看不到本机 skill、` +
          `也没有 MCP。想让它用本机技能得显式配 skills，或改成 {"inheritEnv":true}。`,
      );
    }
    return;
  }
  if (sub === "update") {
    const a = await findAgent(pos[2]);
    if (!a) die(`没有这个 agent：${pos[2]}`);
    const { body } = await api("PATCH", `/api/agents/${a.id}`, readJsonArg(pos[3]));
    console.log(`✓ 改好 ${body.agent.slug}`);
    return;
  }
  if (sub === "rm") {
    const a = await findAgent(pos[2]);
    if (!a) die(`没有这个 agent：${pos[2]}`);
    await api("DELETE", `/api/agents/${a.id}`);
    console.log(`✓ 删了 ${a.slug}`);
    return;
  }
  die(`agents 没有子命令 ${sub}`);
}

async function findAgent(key: string | undefined): Promise<any | null> {
  if (!key) die("要给 agent 的 slug 或 id");
  const { body } = await api("GET", "/api/agents?all=1");
  return (body.agents as any[]).find((a) => a.id === key || a.slug === key) ?? null;
}

/** 建/改任务时允许写 `"agentSlug":"critic"` 代替 `"agentId":"<uuid>"`。
 *  人和模型记得住 slug，记不住 uuid，而记错 uuid 的表现是任务静默用了默认人设。 */
async function withAgentId(p: any): Promise<any> {
  if (!p?.agentSlug) return p;
  const a = await findAgent(p.agentSlug);
  if (!a) die(`没有这个 agent：${p.agentSlug}（用 trellisctl agents list --all 看有哪些）`);
  const { agentSlug, ...rest } = p;
  return { ...rest, agentId: a.id };
}

async function cmdTasks(sub: string) {
  if (!sub || sub === "list") {
    const { body } = await api("GET", "/api/tasks");
    if (has("--json")) return out(body.tasks);
    const cron = await cronLib();
    const { body: ab } = await api("GET", "/api/agents?all=1");
    const agentName = (id: string | null) =>
      id ? ((ab.agents as any[]).find((a) => a.id === id)?.slug ?? "?") : "默认";
    if (!body.tasks.length) return console.log("（一个任务都还没有）");
    for (const t of body.tasks) {
      const trig = (t.triggers ?? [])
        .map((g: any) =>
          g.kind === "cron"
            ? cron
              ? cron.describeCron(String(g.config.expr))
              : `cron ${g.config.expr}`
            : g.kind,
        )
        .join(" + ");
      const last = t.lastRun
        ? `${t.lastRun.status}@${ts(t.lastRun.startedAt ?? t.lastRun.createdAt)}`
        : "从没跑过";
      console.log(
        `${short(t.id)}  ${pad(clip(t.name, 22), 24)}${pad(agentName(t.agentId), 14)} ` +
          `${pad(trig || "无触发器(只能手动跑)", 24)} 上次:${last}${t.enabled ? "" : "  [停用]"}`,
      );
    }
    return;
  }
  if (sub === "get") {
    const { body } = await api("GET", `/api/tasks/${pos[2]}`);
    return out(body);
  }
  if (sub === "create") {
    const p = readJsonArg(pos[2]);
    if (!p.name || !p.prompt) die("任务至少要 { name, prompt }");
    // 服务端只在 contextMode 显式等于 'project' 时才查 workspacePath，而 createTask
    // 的默认值就是 'project' —— 省略 contextMode 会建出「project 模式但没有工作目录」
    // 的任务。在这里补上这道，别把坑留到第一次触发时才炸。
    const mode = p.contextMode ?? "project";
    if (mode === "project" && !p.workspacePath) {
      die(`contextMode=project 必须给 workspacePath（要不带目录的纯对话就写 "contextMode":"chat"）`);
    }
    if (p.workspacePath && !fs.existsSync(p.workspacePath)) {
      die(`工作目录不存在：${p.workspacePath}（spawn 前会被硬挡，先建出来或换一个）`);
    }
    const { body } = await api("POST", "/api/tasks", await withAgentId({ ...p, contextMode: mode }));
    console.log(`✓ 建好任务「${body.task.name}」 id=${body.task.id}`);
    console.log(`  它现在没有任何触发器，不会自己跑。下一步：`);
    console.log(`    trellisctl tasks run ${body.task.id}     # 先手动跑一次，看它到底产出什么`);
    console.log(`    trellisctl runs ${body.task.id}          # 看结果`);
    console.log(`  确认满意之后再挂定时器（triggers add）。`);
    return;
  }
  if (sub === "update") {
    const { body } = await api("PATCH", `/api/tasks/${pos[2]}`, await withAgentId(readJsonArg(pos[3])));
    console.log(`✓ 改好「${body.task.name}」`);
    return;
  }
  if (sub === "rm") {
    await api("DELETE", `/api/tasks/${pos[2]}`);
    console.log(`✓ 删了任务 ${pos[2]}（它跑过的会话留着，那是执行历史）`);
    return;
  }
  if (sub === "run") {
    const { status, body } = await api("POST", `/api/tasks/${pos[2]}/run`);
    if (status === 202) {
      console.log(`… ${body.error}（run ${short(body.runId)} 已留档，稍后会被捞起来）`);
      return;
    }
    console.log(`▶ 跑起来了 run=${short(body.runId)}`);
    console.log(`  看进度：trellisctl runs ${pos[2]}`);
    console.log(`  在界面上看完整过程：/?session=${body.sessionId}&node=${body.nodeId}`);
    return;
  }
  die(`tasks 没有子命令 ${sub}`);
}

async function cmdTriggers(sub: string) {
  if (!sub || sub === "list") {
    const { body } = await api("GET", `/api/tasks/${pos[2]}/triggers`);
    if (has("--json")) return out(body.triggers);
    const cron = await cronLib();
    for (const g of body.triggers) {
      const desc =
        g.kind === "cron" && cron
          ? `${cron.describeCron(String(g.config.expr))}（${g.config.expr}）`
          : JSON.stringify(g.config);
      console.log(
        `${short(g.id)}  ${g.kind.padEnd(13)} ${desc}  上次触发:${ts(g.lastFiredAt)}` +
          `${g.enabled ? "" : "  [停用]"}`,
      );
    }
    if (!body.triggers.length) console.log("（没有触发器，这个任务只能手动跑）");
    return;
  }
  if (sub === "add") {
    const taskId = pos[2];
    const p = readJsonArg(pos[3]);
    if (p.kind === "cron") {
      const cron = await cronLib();
      const expr = String(p.config?.expr ?? "");
      if (cron) {
        const f = cron.parseCron(expr);
        if (!f) die(`cron 表达式无效：${expr}`);
        const gap = minGapMinutes(f);
        if (gap < MIN_GAP_MINUTES && !has("--force")) {
          die(
            `这条 cron 最密每 ${gap} 分钟触发一次，低于 ${MIN_GAP_MINUTES} 分钟的下限。\n` +
              `  每次触发都会真 spawn 一个 claude —— 挂一夜就是几百次。\n` +
              `  真要这么密（比如临时调试）加 --force。`,
          );
        }
        console.log(`将要挂上：${cron.describeCron(expr)}`);
        console.log(`下次触发：${ts(cron.nextFireAfter(f, new Date()))}`);
      } else if (/^(\*|\*\/[1-4])(\s|$)/.test(expr) && !has("--force")) {
        die(`分钟字段是 "${expr.split(/\s+/)[0]}"，触发太密。真要加 --force`);
      }
    }
    const { body } = await api("POST", `/api/tasks/${taskId}/triggers`, p);
    console.log(`✓ 挂好触发器 ${short(body.trigger.id)}（${body.trigger.kind}）—— 任务从现在起会自动跑`);
    return;
  }
  if (sub === "rm") {
    await api("DELETE", `/api/tasks/${pos[2]}/triggers?triggerId=${pos[3]}`);
    console.log(`✓ 摘掉触发器 ${pos[3]}`);
    return;
  }
  die(`triggers 没有子命令 ${sub}`);
}

async function cmdRuns() {
  if (pos[1] === "abort") {
    await api("POST", `/api/task-runs/${pos[2]}/abort`);
    console.log(`✓ 已中止 ${pos[2]}`);
    return;
  }
  const limit = flagVal("--limit") ?? "15";
  const { body } = await api("GET", `/api/tasks/${pos[1]}/runs?limit=${limit}`);
  if (has("--json")) return out(body.runs);
  if (!body.runs.length) return console.log("（还没跑过）");
  for (const r of body.runs) {
    console.log(
      `${short(r.id)}  ${r.status.padEnd(8)} ${r.triggerKind.padEnd(12)} ` +
        `${ts(r.startedAt ?? r.createdAt)}  ${dur(r.startedAt, r.endedAt)}  ` +
        `${r.tokenInput + r.tokenOutput} tok  ${r.errorMessage ? "✗ " + clip(r.errorMessage, 60) : ""}`,
    );
  }
  console.log(`\n看某次执行的完整过程：先 tasks get <taskId> 拿 homeSessionId，或开管理台 /settings/tasks`);
}

async function cmdProviders() {
  const { body } = await api("GET", "/api/providers");
  const list = body?.providers ?? body;
  if (has("--json") || !Array.isArray(list)) return out(body);
  for (const p of list) console.log(`${String(p.id).padEnd(28)} ${p.label ?? ""}`);
  console.log(`\n（任务的 providerId 用这里的 id；省略 = 用默认。codex 系不支持自定义 agent）`);
}

function cmdSkills() {
  const dir = path.join(HOME, ".claude/skills");
  const filter = pos[1]?.toLowerCase();
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((n) => fs.existsSync(path.join(dir, n, "SKILL.md")))
      .filter((n) => !filter || n.toLowerCase().includes(filter));
  } catch {
    die(`读不到 ${dir}`);
  }
  console.log(names.join("\n"));
  console.log(`\n共 ${names.length} 个。给 agent 配技能用：{"skills":[{"kind":"host","name":"<上面的目录名>"}]}`);
}

async function cmdCron() {
  const expr = pos.slice(1).join(" ");
  if (!expr) die(`用法：trellisctl cron "0 9 * * 1-5"`);
  const cron = await cronLib();
  if (!cron) die(`读不到仓库的 lib/cron.ts（脚本被搬出仓库了？），只能靠 triggers add 时服务端校验`);
  const f = cron.parseCron(expr);
  if (!f) die(`表达式无效：${expr}`);
  console.log(`${expr}  →  ${cron.describeCron(expr)}`);
  console.log(`最密间隔：${minGapMinutes(f)} 分钟`);
  let from = new Date();
  for (let i = 0; i < 3; i++) {
    const n = cron.nextFireAfter(f, from);
    if (!n) break;
    console.log(`第 ${i + 1} 次：${ts(n)}`);
    from = new Date(n);
  }
}

// ---------------------------------------------------------------------------
// 平台操作面：会话 / 树 / 节点 / 发消息
// 「树」= 会话画布里的一个根节点（parent_id IS NULL）；一个会话可以有多棵平行树。
// 会话是稳定枚举单位（有 id 有 title），树没有独立 id —— 树 = 它的根节点。
// ---------------------------------------------------------------------------

async function cmdSessions(sub: string) {
  if (!sub || sub === "list") {
    const archived = has("--archived");
    const [{ body }, { body: rb }] = await Promise.all([
      api("GET", `/api/sessions${archived ? "?archived=1" : ""}`),
      api("GET", "/api/runs"),
    ]);
    if (has("--json")) return out(body.sessions);
    const running = new Set<string>(rb?.runningSessionIds ?? []);
    if (!body.sessions.length) {
      return console.log(archived ? "（归档区是空的）" : "（一个会话都没有）");
    }
    for (const s of body.sessions) {
      const ws = s.workspacePath ? path.basename(s.workspacePath) : "纯对话";
      console.log(
        `${running.has(s.id) ? "▶" : " "} ${s.id}  ${pad(clip(s.title, 26), 28)}` +
          `${pad(ws, 20)}${ts(s.updatedAt)}`,
      );
    }
    if (!archived && body.archivedCount) {
      console.log(`\n（另有 ${body.archivedCount} 个已归档，--archived 查看）`);
    }
    if (running.size) console.log(`▶ = 有节点在跑；看具体哪个节点：trellisctl ps`);
    return;
  }
  if (sub === "get") {
    const id = pos[2] ?? die("要会话 id");
    const { body } = await api("GET", `/api/sessions/${id}`);
    if (has("--json")) return out(body);
    const s = body.session;
    const nodes: any[] = body.nodes ?? [];
    console.log(`${s.title}`);
    console.log(
      `  id=${s.id}  ${s.mode === "chat" ? "纯对话" : s.workspacePath ?? s.mode}` +
        `${s.model ? `  model=${s.model}` : ""}${s.archived ? "  [已归档]" : ""}`,
    );
    // 组树：roots（parentId=null）按创建序，子节点按 siblingIndex。
    const children = new Map<string | null, any[]>();
    for (const n of nodes) {
      const k = n.parentId ?? null;
      if (!children.has(k)) children.set(k, []);
      children.get(k)!.push(n);
    }
    for (const list of children.values()) {
      list.sort((a, b) => a.siblingIndex - b.siblingIndex || a.createdAt - b.createdAt);
    }
    const roots = children.get(null) ?? [];
    const walk = (n: any, depth: number) => {
      const tok = n.tokenCount ? ktok(n.tokenCount.input + n.tokenCount.output) : "0";
      const time =
        n.status === "streaming"
          ? `跑了${ago(n.createdAt)}`
          : n.durationMs
            ? `${Math.round(n.durationMs / 1000)}s`
            : "";
      console.log(
        `  ${"  ".repeat(depth)}${nodeIcon(n)} ${n.id}  ${pad(clip(nodeLabel(n), 40), 42)}` +
          `${pad(tok, 7)}${time}`,
      );
      for (const c of children.get(n.id) ?? []) walk(c, depth + 1);
    };
    roots.forEach((root, i) => {
      console.log(`\n树 ${i + 1}/${roots.length}${root.hiddenAt ? "（已雪藏）" : ""}：`);
      walk(root, 0);
    });
    console.log(`\n⏸=等回答 ▶=在跑 ✓=完成 ✗=失败 ◈=引用。看某节点：node get <id>`);
    return;
  }
  if (sub === "rename") {
    const id = pos[2] ?? die("要会话 id");
    const title = pos[3] ?? die("要新标题");
    const { body } = await api("PATCH", `/api/sessions/${id}`, { title });
    console.log(`✓ 改名为「${body.session.title}」（此后自动命名不再覆盖）`);
    return;
  }
  if (sub === "archive") {
    const id = pos[2] ?? die("要会话 id");
    const undo = has("--undo");
    await api("PATCH", `/api/sessions/${id}`, { archived: !undo });
    console.log(undo ? `✓ 已从归档区恢复` : `✓ 已归档（可逆，--undo 恢复）`);
    return;
  }
  if (sub === "rm") {
    const id = pos[2] ?? die("要会话 id");
    const { body } = await api("GET", `/api/sessions/${id}`);
    const n = body.nodes?.length ?? 0;
    if (!has("--yes")) {
      die(
        `将删除会话「${body.session.title}」及其全部 ${n} 个节点，不可恢复。\n` +
          `  只是想让它从列表消失用 sessions archive ${id}（可逆）。确认真删加 --yes`,
      );
    }
    await api("DELETE", `/api/sessions/${id}`);
    console.log(`✓ 删了「${body.session.title}」（${n} 个节点）`);
    return;
  }
  die(`sessions 没有子命令 ${sub}`);
}

/** 谁在跑。/api/runs 只给 session 粒度（run-bus 内存态），具体到节点要再拉
 *  会话找 status=streaming 的行 —— 在跑的会话通常只有一两个，两跳无妨。 */
async function cmdPs() {
  const { body } = await api("GET", "/api/runs");
  const ids: string[] = body?.runningSessionIds ?? [];
  if (!ids.length) return console.log("（现在没有任何节点在跑）");
  for (const sid of ids) {
    const { body: sb } = await api("GET", `/api/sessions/${sid}`, undefined, { tolerate: [404] });
    if (!sb?.session) continue;
    const live = (sb.nodes as any[]).filter((n) => n.status === "streaming");
    for (const n of live) {
      const state = n.pendingInteraction
        ? `⏸ 等回答（${n.pendingInteraction.toolName}）`
        : `▶ 跑了${ago(n.createdAt)}`;
      console.log(`${state}  「${clip(sb.session.title, 24)}」`);
      console.log(`   node=${n.id}`);
      console.log(`   ${clip(n.question, 90)}`);
    }
  }
  console.log(`\n盯到跑完：wait <nodeId>；看输出：node read <nodeId>；停掉：abort <nodeId>`);
}

async function cmdNode(sub: string) {
  const id = pos[2] ?? die("要节点 id");
  if (sub === "get") {
    const { body } = await api("GET", `/api/nodes/${id}`);
    if (has("--json")) return out(body.node);
    const n = body.node;
    const t = n.tokenCount ?? {};
    console.log(`${nodeIcon(n)} ${n.status}${n.pendingInteraction ? "（暂停等回答）" : ""}  node=${n.id}`);
    console.log(`  会话=${n.sessionId}  ${n.parentId ? `父=${n.parentId}` : "树根"}`);
    if (n.question) console.log(`  问：${clip(n.question, 120)}`);
    if (n.topicLabel) console.log(`  主题：${n.topicLabel}`);
    console.log(
      `  tok in=${ktok(t.input)} out=${ktok(t.output)} cache=${ktok((t.cacheRead ?? 0) + (t.cacheCreation ?? 0))}` +
        `${n.durationMs ? `  耗时 ${Math.round(n.durationMs / 1000)}s` : ""}`,
    );
    const st = n.toolCallStats;
    if (st?.total) {
      console.log(
        `  工具 ${st.total} 次（${(st.tools ?? []).join("/")}）` +
          `${st.errors ? ` ${st.errors} 次失败` : ""}${st.subagents ? ` 委派 ${st.subagents}` : ""}`,
      );
    }
    if (n.errorMessage) console.log(`  ✗ ${clip(n.errorMessage, 200)}`);
    if (n.pendingInteraction) {
      console.log(`  ⏸ ${n.pendingInteraction.toolName}  toolUseId=${n.pendingInteraction.toolUseId}`);
      console.log(`     ${clip(JSON.stringify(n.pendingInteraction.input), 500)}`);
      console.log(`     回它：respond ${n.id} --allow / --deny；AskUserQuestion 用 --answers '{"<问题>":"<选项label>"}'`);
    }
    console.log(`  回答 ${(n.response ?? "").length} 字符 —— node read ${n.id} 看正文`);
    return;
  }
  if (sub === "read") {
    const { body } = await api("GET", `/api/nodes/${id}`);
    const resp = body.node.response ?? "";
    if (!resp) {
      return console.log(
        body.node.status === "streaming" ? "（还没吐出内容 —— wait 一下再来）" : "（空回答）",
      );
    }
    console.log(has("--full") ? resp : tailLines(resp, Number(flagVal("--tail") ?? 120)));
    return;
  }
  if (sub === "label") {
    const label = pos[3] ?? die("要标签文本");
    await api("PATCH", `/api/nodes/${id}`, { topicLabel: label });
    console.log(`✓ 标好「${label}」`);
    return;
  }
  if (sub === "rm") {
    if (!has("--yes")) {
      die(`将删除该节点及其下整棵子树，不可恢复。确认加 --yes（会话主根删不掉，那是删会话的事）`);
    }
    const { body } = await api("DELETE", `/api/nodes/${id}`);
    console.log(`✓ 删了 ${body.deletedNodeIds?.length ?? 0} 个节点`);
    return;
  }
  die(`node 没有子命令 ${sub}`);
}

/** ask / retry 共用的 run 生命周期：POST /api/chat 是 SSE，首事件 created 带
 *  session/node id。**服务端 run 与这条 HTTP 解耦** —— 不 --wait 时拿到 id 就
 *  断开，run 继续跑、继续落库；--wait 才守到终态。 */
async function runChat(payload: any, o: { wait: boolean; timeoutS: number }) {
  const base = await resolveBase();
  const r = await apiSse("POST", "/api/chat", payload, (o.wait ? o.timeoutS : 30) * 1000);
  let nodeId = "";
  let sessionId = "";
  let text = "";
  let tools = 0;
  let settled = false;
  try {
    for await (const ev of sseEvents(r)) {
      if (ev.type === "created") {
        sessionId = ev.session?.id ?? ev.node?.sessionId ?? "";
        nodeId = ev.node?.id ?? "";
        console.log(`▶ 跑起来了  session=${sessionId}  node=${nodeId}`);
        console.log(`  界面：${base}/?session=${sessionId}&node=${nodeId}`);
        if (!o.wait) {
          console.log(`  未带 --wait，先撤了（run 在服务端继续）。跟进：`);
          console.log(`    trellisctl wait ${nodeId}`);
          console.log(`    trellisctl node read ${nodeId}`);
          settled = true;
          try {
            await r.body?.cancel();
          } catch {
            /* 断开失败无妨，进程退出连接就没了 */
          }
          return;
        }
        continue;
      }
      if (ev.type === "delta") {
        text += ev.text;
        continue;
      }
      if (ev.type === "tool_call_start") {
        tools += 1;
        continue;
      }
      if (ev.type === "interaction_required") {
        settled = true;
        console.log(`⏸ 它停下来等回答：${ev.toolName}（toolUseId=${ev.toolUseId}）`);
        console.log(`  ${clip(JSON.stringify(ev.input), 500)}`);
        console.log(`  回它：trellisctl respond ${nodeId} --allow / --deny（详见 node get ${nodeId}）`);
        return;
      }
      if (ev.type === "done") {
        settled = true;
        console.log(
          `\n✓ 完成  out ${ktok(ev.usage?.output)} tok` +
            `${tools ? ` · ${tools} 次工具调用` : ""}` +
            `${ev.durationMs ? ` · ${Math.round(ev.durationMs / 1000)}s` : ""}\n`,
        );
        console.log(text || "（空回答）");
        return;
      }
      if (ev.type === "error") {
        settled = true;
        die(`run 失败：${ev.message}`);
      }
    }
  } catch (e) {
    const name = (e as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      if (!nodeId) die(`连接超时，还没拿到节点 id —— 用 trellisctl ps / sessions 查有没有建出来`);
      console.log(`⏱ 等了 ${o.timeoutS}s 还没到终态 —— run 还在服务端跑（断开不杀 run）。`);
      console.log(`  接着守：trellisctl wait ${nodeId} --timeout ${o.timeoutS}`);
      return;
    }
    throw e;
  }
  if (!settled) {
    console.log(`流断了但没收到终态 —— 查一下：trellisctl node get ${nodeId || "<nodeId>"}`);
  }
}

async function cmdAsk() {
  const question = readTextArg(pos[1], "问题");
  const nodeT = flagVal("--node");
  const sessT = flagVal("--session");
  const isNew = has("--new");
  if ([nodeT, sessT, isNew ? "y" : null].filter(Boolean).length !== 1) {
    die(
      `要恰好一个目标：\n` +
        `  --node <id>     在该节点下追问（同一棵树上长分支，继承上文）\n` +
        `  --session <id>  在该会话里开一棵平行新树（同画布，全新上文）\n` +
        `  --new           开全新会话（--workspace <dir> 进 project 模式，缺省纯对话）`,
    );
  }
  let payload: any;
  if (nodeT) {
    payload = { kind: "branch", parentNodeId: nodeT, question };
    const mention = flagVal("--mention");
    if (mention) payload.mentionAgentSlug = mention;
  } else if (sessT) {
    payload = { kind: "root", sessionId: sessT, question };
  } else {
    payload = { kind: "root", question };
    const ws = flagVal("--workspace");
    if (ws) {
      const abs = path.resolve(ws);
      if (!fs.existsSync(abs)) die(`工作目录不存在：${abs}`);
      payload.mode = "project";
      payload.workspacePath = abs;
      // 缺省 YOLO（工具全放行、真改文件）。--approval 让可变更工具逐个弹卡，
      // 卡会变成 pendingInteraction —— wait 看得到，respond 回得了，闭环成立。
      if (has("--approval")) payload.requireApproval = true;
    }
    const agent = flagVal("--agent");
    if (agent) {
      const a = await findAgent(agent);
      if (!a) die(`没有这个 agent：${agent}（trellisctl agents list --all 看有哪些）`);
      payload.agentId = a.id;
    }
    const sp = flagVal("--system-prompt");
    if (sp) payload.systemPrompt = readTextArg(sp, "systemPrompt");
  }
  const provider = flagVal("--provider");
  if (provider) payload.provider = provider;
  await runChat(payload, {
    wait: has("--wait"),
    timeoutS: Number(flagVal("--timeout") ?? 600),
  });
}

async function cmdRetry() {
  const nodeId = pos[1] ?? die("要节点 id");
  const payload: any = { kind: "retry", nodeId };
  const provider = flagVal("--provider");
  if (provider) payload.provider = provider;
  await runChat(payload, {
    wait: has("--wait"),
    timeoutS: Number(flagVal("--timeout") ?? 600),
  });
}

async function cmdAbort() {
  const nodeId = pos[1] ?? die("要节点 id");
  const { status } = await api("POST", `/api/chat/${nodeId}/abort`, undefined, { tolerate: [404] });
  console.log(status === 404 ? "（本来就没在跑 —— 已结束或从没跑过）" : `✓ 已叫停 ${nodeId}`);
}

/** 守一个节点到终态。挂 GET /api/nodes/[id]/stream：catchup 先到（当前快照），
 *  live 时续推增量，无 live run 时直接回放 DB 终态并关流 —— 两种情况一套逻辑。 */
async function cmdWait() {
  const nodeId = pos[1] ?? die("要节点 id");
  const timeoutS = Number(flagVal("--timeout") ?? 600);
  const r = await apiSse("GET", `/api/nodes/${nodeId}/stream`, undefined, timeoutS * 1000);
  let text = "";
  const blocked = (toolName: string, toolUseId: string, input: unknown) => {
    console.log(`⏸ 它在等回答：${toolName}（toolUseId=${toolUseId}）`);
    console.log(`  ${clip(JSON.stringify(input), 500)}`);
    console.log(`  回它：trellisctl respond ${nodeId} --allow / --deny（详见 node get ${nodeId}）`);
  };
  try {
    for await (const ev of sseEvents(r)) {
      if (ev.type === "catchup") {
        text = ev.response ?? "";
        if (ev.pendingInteraction) {
          const p = ev.pendingInteraction;
          blocked(p.toolName, p.toolUseId, p.input);
          return;
        }
        continue;
      }
      if (ev.type === "delta") {
        text += ev.text;
        continue;
      }
      if (ev.type === "interaction_required") {
        blocked(ev.toolName, ev.toolUseId, ev.input);
        return;
      }
      if (ev.type === "done") {
        console.log(`✓ 跑完了  out ${ktok(ev.usage?.output)} tok\n`);
        console.log(tailLines(text, 40));
        if (text.split("\n").length > 40) console.log(`\n（全文：trellisctl node read ${nodeId} --full）`);
        return;
      }
      if (ev.type === "error") {
        die(`✗ 以 error 收场：${ev.message}\n  重跑：trellisctl retry ${nodeId}`);
      }
    }
  } catch (e) {
    const name = (e as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      console.log(`⏱ 等了 ${timeoutS}s 还没到终态 —— run 还在跑。再守：trellisctl wait ${nodeId}`);
      return;
    }
    throw e;
  }
  console.log(`流结束但没见到终态 —— 查：trellisctl node get ${nodeId}`);
}

/** 回答暂停中的交互卡。服务端只认 { toolUseId, behavior, updatedInput? }；
 *  toolUseId 从节点的 pendingInteraction 现取，不让调用方抄 —— 抄错的表现是
 *  409 mismatch，而现取永远是对的那一个。 */
async function cmdRespond() {
  const nodeId = pos[1] ?? die("要节点 id");
  const allow = has("--allow");
  const deny = has("--deny");
  if (allow === deny) die("要 --allow 或 --deny 之一");
  const { body } = await api("GET", `/api/nodes/${nodeId}`);
  const p = body.node.pendingInteraction;
  if (!p) {
    die(`这个节点现在没有等待中的交互（可能已被回答，或 run 已结束）。看状态：node get ${nodeId}`);
  }
  const payload: any = { toolUseId: p.toolUseId, behavior: allow ? "allow" : "deny" };
  if (allow) {
    // allow 必须回传 record（SDK schema 拒 undefined；见 InteractionForm.tsx:509）。
    // 默认原样 echo input；AskUserQuestion 用 --answers 合成 { ...input, answers }；
    // --input 全量自定义（ExitPlanMode 改计划这类）。
    const answers = flagVal("--answers");
    const inputArg = flagVal("--input");
    payload.updatedInput = inputArg
      ? readJsonArg(inputArg)
      : answers
        ? { ...(p.input ?? {}), answers: readJsonArg(answers) }
        : p.input;
    if (has("--always")) payload.alwaysAllowTool = true;
  }
  const message = flagVal("--message");
  if (message) payload.message = message;
  await api("POST", `/api/nodes/${nodeId}/respond`, payload);
  console.log(`✓ 已回（${allow ? "allow" : "deny"}）—— run 继续。守它：trellisctl wait ${nodeId}`);
}

const USAGE = `trellisctl —— Trellis 平台操作 + 后台配置

平台操作（会话 / 树 / 节点）：
  sessions [--archived] [--json]           列会话（▶ = 有节点在跑）
  sessions get <id> [--json]               会话详情 + 树形大纲（一段一棵树）
  sessions rename <id> <标题>
  sessions archive <id> [--undo]           归档 / 恢复（可逆）
  sessions rm <id> --yes                   连节点一起删（不可逆）
  ps                                       现在谁在跑 / 谁停着等回答
  node get <id> [--json]                   单节点：状态、token、工具、暂停详情
  node read <id> [--tail N|--full]         读回答正文（默认尾 120 行）
  node label <id> <标签>                    改节点主题标签
  node rm <id> --yes                       删节点及其子树

  ask <问题|@file|-> <目标> [选项]          发消息（真 spawn 一次 LLM run）
    目标三选一：--node <id>（节点下追问） --session <id>（开平行新树） --new（全新会话）
    --new 可配：--workspace <dir>（project 模式） --agent <slug> --system-prompt <文本|@file>
    通用：--provider <id>  --wait [--timeout 秒=600]（不带 --wait = 发完即走）
    --node 可配 --mention <slug>（本轮 @外援 agent）
  retry <nodeId> [--wait]                  重跑一个节点
  wait <nodeId> [--timeout 秒=600]         守到终态（或它停下来等回答）
  abort <nodeId>                           叫停在跑的节点
  respond <nodeId> --allow|--deny          回答暂停中的审批卡 / 提问卡
    [--answers '{"问":"选项"}'] [--input <json>] [--message <文本>] [--always]

后台配置（agents / tasks / triggers）：
  health                                   探活：连的是哪个实例、认证拿到没
  agents list [--all] [--json]             列 Agent（--all 含停用的）
  agents get <slug|id>
  agents create <json|@file|->             至少 { slug, name }
  agents update <slug|id> <json|@file|->
  agents rm <slug|id>

  tasks list [--json]                      列任务（含触发器与上次结果）
  tasks get <id>
  tasks create <json|@file|->              至少 { name, prompt }；建完不会自己跑
  tasks update <id> <json|@file|->
  tasks rm <id>
  tasks run <id>                           手动跑一次

  triggers list <taskId>
  triggers add <taskId> <json|@file|-> [--force]   { kind, config } —— 这一步之后才会自动跑
  triggers rm <taskId> <triggerId>

  runs <taskId> [--limit N] [--json]       任务运行历史
  runs abort <runId>

  providers                                可用的 providerId
  skills [关键词]                           本机可给 agent 绑的技能名
  cron "<expr>"                            校验 + 人话回显 + 未来三次触发时间

JSON / 长文本参数可以是内联串、@文件路径、或 '-'（从 stdin 读，带引号换行时用这个）。`;

async function main() {
  const cmd = pos[0];
  switch (cmd) {
    case "health": return cmdHealth();
    case "agents": return cmdAgents(pos[1]);
    case "tasks": return cmdTasks(pos[1]);
    case "triggers": return cmdTriggers(pos[1]);
    case "runs": return cmdRuns();
    case "providers": return cmdProviders();
    case "skills": return cmdSkills();
    case "cron": return cmdCron();
    case "sessions": return cmdSessions(pos[1]);
    case "ps": return cmdPs();
    case "node": return cmdNode(pos[1]);
    case "ask": return cmdAsk();
    case "retry": return cmdRetry();
    case "abort": return cmdAbort();
    case "wait": return cmdWait();
    case "respond": return cmdRespond();
    default:
      console.log(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
