import "server-only";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { getDB } from "./sqlite";
import { RoleError } from "./roles";
import { MEMORY_TYPES, type MemoryType } from "@/lib/roles";
import type { DistillMemory, DistillSource, RoleDraft } from "@/lib/role-follow";

// 从会话提炼角色（docs/roles-p2.md C）：读一段会话的问答 → 一次 headless claude 调用 →
// 严格 JSON { name, intro, systemPrompt, memories[] } → 草稿（前端预填表单）。
// 不落库：草稿只是预填，用户在弹窗里改完点「创建」才建角色、写记忆。
//
// 调用管道与 lib/llm/topic.ts 同款（`claude -p`、不落会话、不给工具），只是 prompt 走
// stdin（会话正文最长 ~40k 字，别塞 argv）、超时放宽、模型用 CLI 默认（起人设要的是质量）。

const SOURCE_LIMIT = 50;
/** 喂给模型的会话正文上限（字符）：从最近的轮次往前取，取满为止。 */
export const DISTILL_MAX_CHARS = 40_000;
/** 单条回答最多取这么多：长回答多半是代码 / 日志，对「这人是谁、怎么说话」没帮助。 */
const ANSWER_CLIP = 4_000;
const QUESTION_CLIP = 2_000;
const MEMORY_MAX = 12;
const TIMEOUT_MS = 180_000;

// ── 来源会话 ──────────────────────────────────────────────────────────────

/** 最近 50 个普通会话（kind='user'、未归档、至少一轮已完成），q 按标题模糊匹配。 */
export function listDistillSources(q = ""): DistillSource[] {
  const terms = q.trim().split(/\s+/).filter(Boolean).slice(0, 5);
  const where = ["s.kind = 'user'", "s.archived = 0"];
  const params: string[] = [];
  for (const t of terms) {
    where.push("s.title LIKE ? ESCAPE '\\'");
    params.push(`%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  const rows = getDB()
    .prepare(
      `SELECT s.id, s.title, s.workspace_path, s.updated_at,
              (SELECT COUNT(*) FROM nodes n
                WHERE n.session_id = s.id AND n.status = 'done' AND n.kind = 'qa' AND n.meta_json IS NULL) AS cnt
         FROM sessions s
        WHERE ${where.join(" AND ")}
        ORDER BY s.updated_at DESC
        LIMIT 200`,
    )
    .all(...params) as { id: string; title: string; workspace_path: string | null; updated_at: number; cnt: number }[];
  return rows
    .filter((r) => r.cnt > 0)
    .slice(0, SOURCE_LIMIT)
    .map((r) => ({
      sessionId: r.id,
      title: r.title || "未命名会话",
      workspace: r.workspace_path ? path.basename(r.workspace_path) : null,
      nodeCount: r.cnt,
      updatedAt: r.updated_at,
    }));
}

function clipText(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}\n…（这一段过长，已截断）` : t;
}

/** 会话正文：已完成的问答按时间排，从最近往前取满 maxChars。 */
export function buildDistillTranscript(
  sessionId: string,
  maxChars = DISTILL_MAX_CHARS,
): { title: string; text: string; nodeCount: number; truncated: boolean } {
  const db = getDB();
  const s = db.prepare("SELECT title FROM sessions WHERE id = ? AND archived = 0").get(sessionId) as
    | { title: string }
    | undefined;
  if (!s) throw new RoleError("来源会话不存在或已归档", 404);
  const rows = db
    .prepare(
      `SELECT question, response FROM nodes
        WHERE session_id = ? AND status = 'done' AND kind = 'qa' AND meta_json IS NULL
        ORDER BY created_at ASC`,
    )
    .all(sessionId) as { question: string; response: string }[];
  if (rows.length === 0) throw new RoleError("这段会话还没有已完成的回答", 400);
  const blocks: string[] = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const b = `### 用户\n${clipText(rows[i].question, QUESTION_CLIP)}\n\n### 助手\n${clipText(rows[i].response, ANSWER_CLIP)}`;
    if (used + b.length > maxChars && blocks.length > 0) break;
    blocks.unshift(b.length > maxChars ? b.slice(0, maxChars) : b);
    used += b.length + 2;
  }
  return {
    title: s.title || "未命名会话",
    text: blocks.join("\n\n"),
    nodeCount: rows.length,
    truncated: blocks.length < rows.length,
  };
}

// ── 提示词 ────────────────────────────────────────────────────────────────

export const DISTILL_SYSTEM_PROMPT = [
  "你在帮用户把一段已经聊得很好的对话，提炼成一个可以长期合作的「角色」。",
  "读完对话后，只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块。字段：",
  "",
  "{",
  '  "name": "角色名，2-6 个字，像人名或职位，例如「老周」「架构审稿人」",',
  '  "intro": "一句话介绍，≤40 字：它是干什么的、什么风格",',
  '  "systemPrompt": "人设正文（第二人称「你」），200-600 字：它负责什么、怎么思考、怎么说话、什么不做。要从这段对话里助手被用户认可的做法与用户的要求里来，不要空泛",',
  '  "memories": [',
  '    { "name": "小写英文短横线短名，如 prefers-short-answers", "description": "一句话说明，写进索引", "type": "user | feedback | project | reference", "body": "事实本身，必要时附来由" }',
  "  ]",
  "}",
  "",
  "memories 是这个角色该从这段对话里带走的长期记忆，0-8 条：",
  "- user：关于用户本人（身份、习惯、环境）；feedback：用户的偏好与纠正；project：从代码里推不出来的项目事实与决定；reference：外部资料、链接、去哪找什么。",
  "- 不记：这一轮的临时任务细节、进度流水、代码结构、密钥与口令。",
  "所有文字用对话的主要语言（通常是中文）。",
].join("\n");

function userPrompt(title: string, transcript: string, truncated: boolean): string {
  return [
    `会话标题：${title}`,
    truncated ? "（会话较长，下面只给最近的一部分轮次）" : "",
    "",
    "<conversation>",
    transcript,
    "</conversation>",
    "",
    "只输出 JSON。",
  ]
    .filter((l, i) => l !== "" || i > 1)
    .join("\n");
}

const RETRY_SUFFIX = "\n\n上一次的输出不是合法 JSON。这一次只输出一个 JSON 对象，第一个字符必须是 {，最后一个字符必须是 }。";

// ── 解析 ──────────────────────────────────────────────────────────────────

/** 记忆名 → 合法文件名（与 MEMORY_FILE_RE 同口径），同一份草稿内去重。 */
export function memoryFileFor(name: string, taken: Set<string>, index: number): string {
  let base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  if (!base || !/^[a-z0-9]/.test(base)) base = `memory-${index + 1}`;
  let file = `${base}.md`;
  for (let n = 2; taken.has(file); n++) file = `${base}-${n}.md`;
  taken.add(file);
  return file;
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** 模型输出 → 草稿字段。容忍 ```json 围栏、前后废话、尾逗号；结构不对返回 null（调用方重试一次）。 */
export function parseDistillOutput(raw: string): Omit<RoleDraft, "source"> | null {
  let text = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  const body = text.slice(start, end + 1);
  let obj: unknown;
  try {
    obj = JSON.parse(body);
  } catch {
    try {
      obj = JSON.parse(body.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const name = Array.from(str(o.name, 200)).slice(0, 40).join("");
  const systemPrompt = str(o.systemPrompt, 100_000);
  if (!name || !systemPrompt) return null;
  const taken = new Set<string>();
  const memories: DistillMemory[] = (Array.isArray(o.memories) ? o.memories : [])
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object" && !Array.isArray(m))
    .map((m) => ({
      name: str(m.name, 200),
      description: str(m.description, 500),
      type: ((MEMORY_TYPES as readonly string[]).includes(m.type as string) ? m.type : "project") as MemoryType,
      body: str(m.body, 64 * 1024),
    }))
    .filter((m) => m.name && m.body)
    .slice(0, MEMORY_MAX)
    .map((m, i) => ({ ...m, file: memoryFileFor(m.name, taken, i) }));
  return {
    name,
    intro: Array.from(str(o.intro, 400)).slice(0, 200).join(""),
    systemPrompt,
    memories,
  };
}

// ── 调用 ──────────────────────────────────────────────────────────────────

export type DistillRunner = (systemPrompt: string, prompt: string) => Promise<string | null>;

/** `claude -p`：prompt 走 stdin，不落会话、不给工具，超时 3 分钟。失败返回 null。 */
export const claudeDistillRunner: DistillRunner = (systemPrompt, prompt) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const proc = spawn(
      "claude",
      ["-p", "--output-format", "text", "--no-session-persistence", "--tools", "", "--system-prompt", systemPrompt],
      { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] },
    );
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      finish(null);
    }, TIMEOUT_MS);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => out.push(c));
    proc.stderr.on("data", (c: Buffer) => err.push(c));
    proc.on("error", (e) => {
      clearTimeout(timer);
      console.warn("[roles/distill] spawn claude 失败：", e);
      finish(null);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.warn(`[roles/distill] claude 退出码 ${code}：${Buffer.concat(err).toString("utf8").slice(0, 500)}`);
        return finish(null);
      }
      finish(Buffer.concat(out).toString("utf8").trim() || null);
    });
    proc.stdin.end(prompt);
  });

/** 读会话 → 调模型（解析失败重试一次）→ 草稿。模型两次都没给出合法 JSON → 502。 */
export async function distillRole(sessionId: string, run: DistillRunner = claudeDistillRunner): Promise<RoleDraft> {
  const t = buildDistillTranscript(sessionId);
  const prompt = userPrompt(t.title, t.text, t.truncated);
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await run(DISTILL_SYSTEM_PROMPT, attempt === 0 ? prompt : prompt + RETRY_SUFFIX);
    const parsed = raw ? parseDistillOutput(raw) : null;
    if (parsed) {
      return {
        ...parsed,
        source: { sessionId, title: t.title, nodeCount: t.nodeCount, truncated: t.truncated },
      };
    }
    console.warn(`[roles/distill] 第 ${attempt + 1} 次没拿到合法 JSON：${(raw ?? "(空)").slice(0, 200)}`);
  }
  throw new RoleError("模型没能给出可用的草稿，换一段会话或稍后再试", 502);
}
