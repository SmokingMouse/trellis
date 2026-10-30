import "server-only";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDB } from "./sqlite";
import { getAgent, listAgents, type AgentRecord } from "./agents";
import { RoleError, ensureRoleDir, openRole } from "./roles";
import { appendSystemNode } from "./system-node";
import { insertRoleChanges, parseNightlyProposal, proposalContext, readRoleSkills } from "./role-changes";
import {
  NIGHTLY_FREQUENCY_LABEL,
  ROLE_CHANGE_LABEL,
  isNightlyFrequency,
  latestNightlySlot,
  roleChangeTitle,
  type NightlyFrequency,
  type RoleNightlyState,
} from "@/lib/role-changes";

// 夜间整理（docs/roles-p2.md A 包）：每个角色一个内置例行，不占 tasks 行。
//
// 调度挂在 task-scheduler 的每分钟 tick 上（tickRoleNightly）。每个角色每个计划槽
// （每天 / 每周一 03:30）只跑一次：role_nightly.last_slot 用条件 UPDATE 抢，抢到才跑 ——
// 重启后 catch-up、两次 tick 撞车都落在这条 UPDATE 上。错过的槽 6h 内补跑（与任务调度
// 的 catch-up 窗口一致），再晚就等下一个槽。
//
// 一次整理：
//   1. 收集自 cursor_at 以来、agent_id = 角色的会话里已完成的问答（系统节点除外）；
//      一条都没有 → 记 skipped，不调模型。
//   2. 起一次 headless claude：--tools "" 没有任何工具（物理上写不了文件）、
//      --no-session-persistence 不留 jsonl；system prompt = 角色人设 + 整理说明，
//      user prompt = 新对话 + 现有记忆 + 现有技能，要求只输出 JSON。
//   3. parseNightlyProposal 宽进严出；有提案就插整理卡（appendSystemNode）+ role_changes；
//      没提案不出声。拿不到 JSON 记 error、游标不动（下次重读）。

const CATCHUP_WINDOW_MS = 6 * 60 * 60 * 1000;
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const Q_MAX = 2_000;
const A_MAX = 4_000;
const TRANSCRIPT_BUDGET = 60_000;
const MEMORY_BUDGET = 40_000;
const PERSONA_MAX = 4_000;

// ---------------------------------------------------------------- 模型调用（测试可替换）

export type NightlyRunnerArgs = { systemPrompt: string; prompt: string; model: string; cwd: string };
export type NightlyRunner = (args: NightlyRunnerArgs) => Promise<string>;

/** 默认：claude -p，无工具、不落 jsonl。非零退出 / 超时抛错（带 stderr 尾巴）。 */
const claudeRunner: NightlyRunner = ({ systemPrompt, prompt, model, cwd }) =>
  new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      [
        "-p",
        prompt,
        "--output-format",
        "text",
        "--no-session-persistence",
        "--tools",
        "",
        "--system-prompt",
        systemPrompt,
        "--model",
        model,
      ],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* 已退出 */
      }
      reject(new Error(`整理超时（${RUN_TIMEOUT_MS / 60_000} 分钟）`));
    }, RUN_TIMEOUT_MS);
    proc.stdout.on("data", (c: Buffer) => out.push(c));
    proc.stderr.on("data", (c: Buffer) => err.push(c));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      if (code !== 0) {
        const tail = Buffer.concat(err).toString("utf8").trim().slice(-400) || stdout.trim().slice(-400);
        reject(new Error(`claude 退出码 ${code}${tail ? `：${tail}` : ""}`));
        return;
      }
      resolve(stdout);
    });
  });

let runner: NightlyRunner = claudeRunner;

/** 测试注入假模型；传 null 恢复默认。 */
export function setNightlyRunnerForTests(r: NightlyRunner | null): void {
  runner = r ?? claudeRunner;
}

// ---------------------------------------------------------------- 状态

type StateRow = {
  role_id: string;
  cursor_at: number | null;
  last_slot: number | null;
  last_run_at: number | null;
  last_status: RoleNightlyState["lastStatus"];
  last_error: string | null;
  running: number;
};

function ensureStateRow(roleId: string): StateRow {
  const db = getDB();
  db.prepare("INSERT OR IGNORE INTO role_nightly (role_id) VALUES (?)").run(roleId);
  return db.query("SELECT * FROM role_nightly WHERE role_id = ?").get(roleId) as StateRow;
}

function requireRole(roleId: string): AgentRecord {
  const a = getAgent(roleId);
  if (!a || a.kind !== "role") throw new RoleError("role not found", 404);
  return a;
}

export function getNightlyFrequency(roleId: string): NightlyFrequency {
  const r = getDB().query("SELECT nightly_freq FROM agents WHERE id = ?").get(roleId) as
    | { nightly_freq: string }
    | null;
  return r && isNightlyFrequency(r.nightly_freq) ? r.nightly_freq : "daily";
}

export function setNightlyFrequency(roleId: string, freq: unknown): RoleNightlyState {
  requireRole(roleId);
  if (!isNightlyFrequency(freq)) throw new RoleError("frequency 只能是 daily / weekly / off", 400);
  getDB().prepare("UPDATE agents SET nightly_freq = ?, updated_at = ? WHERE id = ?").run(freq, Date.now(), roleId);
  return getNightlyState(roleId);
}

type NewNode = { id: string; question: string; response: string; createdAt: number };

/** 自 cursor 以来的新问答：agent_id = 角色的会话里已完成、非系统节点。 */
function newNodesSince(roleId: string, cursor: number | null): NewNode[] {
  return (
    getDB()
      .query(
        `SELECT n.id, n.question, n.response, n.created_at AS createdAt
           FROM nodes n JOIN sessions s ON s.id = n.session_id
          WHERE s.agent_id = ? AND n.status = 'done' AND n.system_meta_json IS NULL
            AND n.kind = 'qa' AND n.created_at > ?
          ORDER BY n.created_at ASC`,
      )
      .all(roleId, cursor ?? 0) as NewNode[]
  );
}

export function getNightlyState(roleId: string): RoleNightlyState {
  requireRole(roleId);
  const s = ensureStateRow(roleId);
  return {
    frequency: getNightlyFrequency(roleId),
    cursorAt: s.cursor_at,
    lastRunAt: s.last_run_at,
    lastStatus: s.last_status,
    lastError: s.last_error,
    running: s.running === 1,
    pendingNodes: newNodesSince(roleId, s.cursor_at).length,
  };
}

// ---------------------------------------------------------------- prompt

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…（截断）`;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 新对话转写：新的在后；超预算从最早的开始丢，并注明丢了几轮。 */
export function buildTranscript(nodes: NewNode[], roleName: string): { text: string; omitted: number } {
  const blocks = nodes.map(
    (n) =>
      `### ${fmtTime(n.createdAt)}\n用户：${clip(n.question.trim(), Q_MAX)}\n\n${roleName}：${clip(n.response.trim(), A_MAX)}`,
  );
  let total = 0;
  let keepFrom = blocks.length;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (total + blocks[i].length > TRANSCRIPT_BUDGET && keepFrom < blocks.length) break;
    total += blocks[i].length;
    keepFrom = i;
  }
  const omitted = keepFrom;
  const text = (omitted ? `（更早的 ${omitted} 轮因篇幅省略）\n\n` : "") + blocks.slice(keepFrom).join("\n\n");
  return { text, omitted };
}

function readMemoriesForPrompt(homeDir: string): string {
  const dir = path.join(homeDir, "memories");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^[a-z0-9][a-z0-9._-]{0,80}\.md$/.test(f)).sort();
  } catch {
    return "（还没有记忆）";
  }
  if (!files.length) return "（还没有记忆）";
  let total = 0;
  const parts: string[] = [];
  for (const f of files) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    const block = `#### memories/${f}\n${clip(text.trim(), 6_000)}`;
    if (total + block.length > MEMORY_BUDGET) {
      parts.push(`（其余 ${files.length - parts.length} 条记忆因篇幅省略，只给文件名：${files.slice(parts.length).join("、")}）`);
      break;
    }
    total += block.length;
    parts.push(block);
  }
  return parts.join("\n\n");
}

export function buildNightlySystemPrompt(role: Pick<AgentRecord, "name" | "systemPrompt">): string {
  const persona = role.systemPrompt.trim();
  return [
    `你是「${role.name}」，一个长期陪用户工作的角色。现在是你的夜间整理时间：回看最近的对话，整理你的长期记忆。`,
    persona ? `\n你的人设（供你判断什么对你重要）：\n${clip(persona, PERSONA_MAX)}` : "",
    ``,
    `## 你要做的`,
    ``,
    `读下面的「新对话」和「现有记忆」，提出记忆改动。你**没有任何工具**，也**不要**假装写文件 —— 只输出一个 JSON 对象，服务端会把它变成提案卡，用户逐条确认后才生效。`,
    ``,
    `四种改动：`,
    `- add：从新对话里学到、值得长期记住、现有记忆里还没有的事。`,
    `- merge：两条或更多现有记忆说的是一回事 / 能合成一条更好的，合并成一条（files 列要合并的现有文件名，into 给合并后的完整内容）。`,
    `- delete：现有记忆已经过时、被新对话推翻、或者是错的。`,
    `- skill：同一套做法在对话里反复出现（至少两次），值得存成一个技能（可复用的操作步骤）。`,
    ``,
    `值得记：用户的身份、习惯、偏好，用户纠正过你的地方；从代码里推不出来的项目事实（决定、约定、背景）；有用的外部参考（链接、文档位置）。`,
    `不记：一次性的任务细节、进度流水、仓库里本来就查得到的东西、密钥与口令。宁缺毋滥：没有值得改的就返回空数组。`,
    ``,
    `## 输出格式（只输出这个 JSON，不要任何别的文字）`,
    ``,
    "```json",
    `{`,
    `  "summary": "一句话：读了什么、改了什么",`,
    `  "changes": [`,
    `    { "kind": "add", "reason": "来自哪段对话 / 为什么记", "memory": { "file": "prefers-short-answers.md", "name": "一句话标题", "description": "一句话说明", "type": "feedback", "body": "正文：事实本身，必要时附来由" } },`,
    `    { "kind": "merge", "reason": "为什么合", "files": ["a.md", "b.md"], "into": { "file": "a.md", "name": "...", "description": "...", "type": "feedback", "body": "..." } },`,
    `    { "kind": "delete", "reason": "为什么删", "file": "old-fact.md" },`,
    `    { "kind": "skill", "reason": "用过几次、什么场景", "name": "review-diff", "description": "什么时候用这个技能", "body": "技能正文（markdown，一步步怎么做）" }`,
    `  ]`,
    `}`,
    "```",
    ``,
    `规则：type 只用 user / feedback / project / reference；file 用小写字母、数字、连字符，以 .md 结尾；merge / delete 只能引用「现有记忆」里列出的文件名；skill 的 name 用小写字母、数字、连字符。reason 用中文、一句话。`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function buildNightlyPrompt(opts: {
  roleName: string;
  transcript: string;
  memories: string;
  skills: { name: string; description: string }[];
}): string {
  return [
    `# 新对话（自上次整理以来）`,
    ``,
    opts.transcript,
    ``,
    `# 现有记忆`,
    ``,
    opts.memories,
    ``,
    `# 现有技能`,
    ``,
    opts.skills.length ? opts.skills.map((s) => `- ${s.name}：${s.description}`).join("\n") : "（还没有技能）",
    ``,
    `按 system prompt 的格式只输出 JSON。`,
  ].join("\n");
}

// ---------------------------------------------------------------- 一次整理

export type NightlyRunResult =
  | { status: "skipped"; reason: string }
  | { status: "busy" }
  | { status: "empty"; read: number }
  | { status: "ran"; read: number; nodeId: string; changeIds: string[] }
  | { status: "error"; error: string };

/** 能不能整理：角色启用、记忆开着、固定会话还在。不能 → 原因。 */
function ineligible(role: AgentRecord): string | null {
  if (!role.enabled) return "角色已停用";
  if (!role.memoryEnabled) return "记忆已关";
  if (!openRole(role.id).sessionId) return "还没有固定会话";
  return null;
}

function finishState(roleId: string, patch: Partial<StateRow>): void {
  const keys = Object.keys(patch) as (keyof StateRow)[];
  getDB()
    .prepare(`UPDATE role_nightly SET ${keys.map((k) => `${k} = ?`).join(", ")}, running = 0 WHERE role_id = ?`)
    .run(...keys.map((k) => (patch[k] ?? null) as string | number | null), roleId);
}

/** 跑一次整理。调度和「立即整理」共用；同一角色同一时刻只有一个在跑。 */
export async function runRoleNightly(roleId: string): Promise<NightlyRunResult> {
  const role = requireRole(roleId);
  const why = ineligible(role);
  const db = getDB();
  const state = ensureStateRow(roleId);
  const now = Date.now();
  if (why) {
    db.prepare("UPDATE role_nightly SET last_run_at = ?, last_status = 'skipped', last_error = ? WHERE role_id = ?")
      .run(now, why, roleId);
    return { status: "skipped", reason: why };
  }
  // 抢运行标记：条件 UPDATE，没抢到 = 别处正在跑。
  if (db.prepare("UPDATE role_nightly SET running = 1 WHERE role_id = ? AND running = 0").run(roleId).changes !== 1) {
    return { status: "busy" };
  }
  try {
    const nodes = newNodesSince(roleId, state.cursor_at);
    if (!nodes.length) {
      finishState(roleId, { last_run_at: now, last_status: "skipped", last_error: "没有新对话" });
      return { status: "skipped", reason: "没有新对话" };
    }
    const homeDir = ensureRoleDir(role.slug);
    const { text } = buildTranscript(nodes, role.name);
    const skills = readRoleSkills(homeDir);
    const output = await runner({
      systemPrompt: buildNightlySystemPrompt(role),
      prompt: buildNightlyPrompt({
        roleName: role.name,
        transcript: text,
        memories: readMemoriesForPrompt(homeDir),
        skills,
      }),
      model: role.model ?? "sonnet",
      cwd: os.tmpdir(),
    });
    const parsed = parseNightlyProposal(output, proposalContext(homeDir));
    if (!parsed.ok) {
      const err = `模型输出里没有 JSON：${clip(output.trim().replace(/\s+/g, " "), 200) || "（空）"}`;
      finishState(roleId, { last_run_at: now, last_status: "error", last_error: err });
      return { status: "error", error: err };
    }
    const cursor = nodes[nodes.length - 1].createdAt;
    if (!parsed.changes.length) {
      finishState(roleId, { cursor_at: cursor, last_run_at: now, last_status: "empty", last_error: null });
      return { status: "empty", read: nodes.length };
    }
    // 角色可能在模型跑的这几十秒里被归档了固定会话：重新取一次。
    const sessionId = openRole(roleId).sessionId;
    if (!sessionId) {
      finishState(roleId, { last_run_at: now, last_status: "error", last_error: "固定会话不见了" });
      return { status: "error", error: "固定会话不见了" };
    }
    const hasSkill = parsed.changes.some((c) => c.kind === "skill");
    const hasMemory = parsed.changes.some((c) => c.kind !== "skill");
    const subtitle = `读了 ${nodes.length} 轮新对话 · ${
      hasSkill && hasMemory ? "记忆和技能各有改动" : hasSkill ? "技能有改动" : "记忆有改动"
    }`;
    const body = [
      parsed.summary || subtitle,
      "",
      ...parsed.changes.map((c) => `- ${ROLE_CHANGE_LABEL[c.kind]}：${roleChangeTitle(c)}${c.reason ? `（${c.reason}）` : ""}`),
    ].join("\n");
    const { nodeId } = appendSystemNode({
      sessionId,
      title: "夜间整理",
      body,
      kind: "role-nightly",
      meta: { roleId, read: nodes.length, summary: parsed.summary, subtitle, dropped: parsed.dropped },
    });
    const changeIds = insertRoleChanges(roleId, nodeId, parsed.changes);
    finishState(roleId, { cursor_at: cursor, last_run_at: now, last_status: "ran", last_error: null });
    return { status: "ran", read: nodes.length, nodeId, changeIds };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    finishState(roleId, { last_run_at: now, last_status: "error", last_error: clip(err, 500) });
    return { status: "error", error: err };
  }
}

// ---------------------------------------------------------------- 调度

/** 抢这个角色的计划槽：last_slot 比 slot 旧才抢得到。 */
function claimSlot(roleId: string, slot: number): boolean {
  ensureStateRow(roleId);
  return (
    getDB()
      .prepare("UPDATE role_nightly SET last_slot = ? WHERE role_id = ? AND (last_slot IS NULL OR last_slot < ?)")
      .run(slot, roleId, slot).changes === 1
  );
}

/** 调度器每分钟调一次。到了槽（或槽在 6h 补跑窗口内且没跑过）就逐个角色跑；
 * 角色之间串行 —— 夜里不赶时间，并发起一堆 claude 只会撞并发 / 限流。 */
export async function tickRoleNightly(now: Date): Promise<string[]> {
  const ran: string[] = [];
  for (const role of listAgents({ kind: "role" })) {
    try {
      if (!role.enabled || !role.memoryEnabled) continue;
      const slot = latestNightlySlot(getNightlyFrequency(role.id), now);
      if (slot === null || now.getTime() - slot > CATCHUP_WINDOW_MS) continue;
      if (!openRole(role.id).sessionId) continue;
      if (!claimSlot(role.id, slot)) continue;
      const r = await runRoleNightly(role.id);
      ran.push(role.id);
      if (r.status === "ran" || r.status === "error") {
        console.log(`[role-nightly] ${role.name}：${r.status}${r.status === "error" ? ` ${r.error}` : ""}`);
      }
    } catch (e) {
      console.error(`[role-nightly] ${role.name} 整理失败：`, e);
    }
  }
  return ran;
}

/** 一览 / 例行 tab 上「夜间整理」那一行的副标题。 */
export function nightlyLabel(freq: NightlyFrequency): string {
  return freq === "off" ? "已关闭" : `${NIGHTLY_FREQUENCY_LABEL[freq]} · 没新对话就跳过`;
}
