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

async function api(method: string, p: string, body?: unknown): Promise<ApiResult> {
  const base = await resolveBase();
  const headers: Record<string, string> = {};
  const tok = authToken();
  if (tok) headers.cookie = `${AUTH_COOKIE}=${tok}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(base + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let j: any = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应，保留原文用于报错 */
  }
  if (r.status === 401) {
    die(
      `401 —— 认证闸开着，但没拿到 token。\n` +
        `  真源：~/.trellis/shared/.env.local 里的 TRELLIS_AUTH_TOKEN\n` +
        `  或显式给：TRELLIS_AUTH_TOKEN=xxx trellisctl ...`,
    );
  }
  // 202 是「排队中 / 上一次还在跑」，那是状态不是错误（见 tasks/[id]/run/route.ts）。
  if (!r.ok && r.status !== 202) {
    die(`${method} ${p} → ${r.status}: ${j?.error ?? text.slice(0, 400)}`);
  }
  return { status: r.status, body: j };
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

const USAGE = `trellisctl —— Trellis 后台配置

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

  runs <taskId> [--limit N] [--json]       运行历史
  runs abort <runId>

  providers                                可用的 providerId
  skills [关键词]                           本机可给 agent 绑的技能名
  cron "<expr>"                            校验 + 人话回显 + 未来三次触发时间

JSON 参数可以是内联串、@文件路径、或 '-'（从 stdin 读，prompt 带引号换行时用这个）。`;

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
    default:
      console.log(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
