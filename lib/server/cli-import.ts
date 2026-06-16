// CLI session jsonl → trellis 节点树 解析器（Stage A，纯函数，无 DB / 无 server-only）。
//
// Claude Code CLI 把每个会话存成 ~/.claude/projects/<encoded-cwd>/<sid>.jsonl，
// 每行一条 entry，靠 parentUuid 串成链（rewind/edit 才分叉）。本模块把一个 jsonl
// collapse 成 trellis 的 Q/A 节点树：一条「真·user 文本消息」开一个节点，到下一条
// 真 user 文本之间的 assistant 行折成 response + toolCalls。详见 progress/cli-sync.md。
//
// 纯解析、不写库 —— DB 落地 + 增量 watcher 在 Stage B 单独接。这样解析逻辑可脱离
// 服务端独立验证（node --experimental-strip-types）。
import fs from "node:fs";
import type { ToolCall } from "@/lib/types";

// ── jsonl entry 形状（只声明用到的字段，其余忽略）────────────────────────────
type ContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};
type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};
type RawEntry = {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  sessionId?: string;
  aiTitle?: string;
  toolUseResult?: { stderr?: string; stdout?: string } | unknown;
  message?: { role?: string; content?: string | ContentBlock[]; usage?: Usage };
};

export type ParsedTurn = {
  // 节点 id = 该 turn 首条 user entry 的 uuid（确定性 → 重复导入幂等）。
  id: string;
  parentId: string | null;
  siblingIndex: number;
  question: string;
  response: string;
  toolCalls: ToolCall[];
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    contextTokens: number | null;
  };
  createdAt: number;
};

export type ParsedCliSession = {
  sessionId: string;
  cwd: string | null;
  gitBranch: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  // 文件里最后一条带 uuid 的 entry —— 增量游标：watcher 比对它判断有无新增。
  lastUuid: string | null;
  turns: ParsedTurn[];
};

// ── helpers ─────────────────────────────────────────────────────────────────

function ms(ts: string | undefined): number {
  if (!ts) return 0;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}

function userText(e: RawEntry): string | null {
  const c = e.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const texts = c
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string);
    if (texts.length) return texts.join("\n");
  }
  return null;
}

function isToolResultEntry(e: RawEntry): boolean {
  const c = e.message?.content;
  return Array.isArray(c) && c.some((b) => b.type === "tool_result");
}

// CLI 注入的命令/系统行不是真用户提问 —— 过滤掉。
function isCommandNoise(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith("<command-name>") ||
    t.startsWith("<command-message>") ||
    t.startsWith("<local-command-") ||
    t.startsWith("<bash-input>") ||
    t.startsWith("<bash-stdout>") ||
    t.startsWith("Caveat:")
  );
}

function isTurnStart(e: RawEntry): boolean {
  if (e.type !== "user") return false;
  if (isToolResultEntry(e)) return false;
  const text = userText(e);
  if (!text || !text.trim()) return false;
  if (isCommandNoise(text)) return false;
  return true;
}

// tool_result 的 content → 展平成字符串（string 直用；array 取 text 块拼接）。
function toolResultString(content: unknown): string | null {
  if (content == null) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((x) =>
        typeof x === "string"
          ? x
          : x && typeof x === "object" && "text" in x
            ? String((x as { text: unknown }).text)
            : JSON.stringify(x),
      )
      .join("\n");
  }
  return String(content);
}

// ── 主解析 ──────────────────────────────────────────────────────────────────

export function parseCliSessionJsonl(
  jsonlPath: string,
): ParsedCliSession | null {
  let raw: string;
  try {
    raw = fs.readFileSync(jsonlPath, "utf8");
  } catch {
    return null;
  }

  const all: RawEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      all.push(JSON.parse(line) as RawEntry);
    } catch {
      /* 跳过坏行 */
    }
  }

  // 会话级元数据：sessionId（兜底用文件名）/ cwd / gitBranch / ai-title。
  const sessionId =
    all.find((e) => e.sessionId)?.sessionId ??
    jsonlPath.replace(/^.*\//, "").replace(/\.jsonl$/, "");
  const cwd = all.find((e) => e.cwd)?.cwd ?? null;
  const gitBranch = all.find((e) => e.gitBranch)?.gitBranch ?? null;
  const aiTitle =
    [...all].reverse().find((e) => e.type === "ai-title")?.aiTitle ?? null;

  // 对话行：turn-start / member 只认 user/assistant；v1 丢弃 sidechain。
  const entries = all.filter(
    (e) =>
      e.uuid &&
      (e.type === "user" || e.type === "assistant") &&
      e.isSidechain !== true,
  );
  if (entries.length === 0) return null;

  // byUuid 收全部带 uuid 的 entry（含 type:"system" 的 compact/边界标记）——
  // CLI 在每个 turn 之间插 system 节点承载父链，过滤掉会把链打断、让每个 turn
  // 变成孤根。ownerTurn 上溯时需穿过这些非对话节点继续走。
  const byUuid = new Map<string, RawEntry>();
  for (const e of all) if (e.uuid) byUuid.set(e.uuid, e);

  // 每条 entry 归属哪个 turn-start（沿 parentUuid 上溯到最近的 turn-start）。
  const turnOf = new Map<string, string | null>();
  function ownerTurn(uuid: string): string | null {
    const cached = turnOf.get(uuid);
    if (cached !== undefined) return cached;
    const e = byUuid.get(uuid);
    if (!e) {
      turnOf.set(uuid, null);
      return null;
    }
    // 占位防环（坏 jsonl 自指）。
    turnOf.set(uuid, null);
    let owner: string | null;
    if (isTurnStart(e)) owner = e.uuid as string;
    else owner = e.parentUuid ? ownerTurn(e.parentUuid) : null;
    turnOf.set(uuid, owner);
    return owner;
  }

  // 全局 tool_result 索引：tool_use_id → { 输出文本, is_error, stderr }。
  const resultById = new Map<
    string,
    { output: string | null; isError: boolean; stderr: string | null }
  >();
  for (const e of entries) {
    if (e.type !== "user") continue;
    const c = e.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type === "tool_result" && b.tool_use_id) {
        const tur = e.toolUseResult as { stderr?: string } | undefined;
        resultById.set(b.tool_use_id, {
          output: toolResultString(b.content),
          isError: b.is_error === true,
          stderr: tur?.stderr ? tur.stderr : null,
        });
      }
    }
  }

  // 收集 turn-start，组装节点。
  const starts = entries.filter(isTurnStart);
  const membersByTurn = new Map<string, RawEntry[]>();
  for (const e of entries) {
    if (e.type !== "assistant") continue;
    const owner = ownerTurn(e.uuid as string);
    if (!owner) continue;
    (membersByTurn.get(owner) ?? membersByTurn.set(owner, []).get(owner)!).push(
      e,
    );
  }

  const turns: ParsedTurn[] = [];
  for (const start of starts) {
    const id = start.uuid as string;
    const members = (membersByTurn.get(id) ?? []).sort(
      (a, b) => ms(a.timestamp) - ms(b.timestamp),
    );

    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    let lastUsage: Usage | undefined;
    for (const m of members) {
      const startedAt = ms(m.timestamp);
      const c = m.message?.content;
      if (m.message?.usage) lastUsage = m.message.usage;
      if (typeof c === "string") {
        if (c.trim()) textParts.push(c);
        continue;
      }
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b.type === "text" && b.text?.trim()) {
          textParts.push(b.text);
        } else if (b.type === "tool_use" && b.id) {
          const res = resultById.get(b.id);
          toolCalls.push({
            id: b.id,
            name: b.name ?? "tool",
            input: b.input ?? null,
            output: res?.output ?? null,
            stderr: res?.stderr ?? null,
            status: res ? (res.isError ? "error" : "done") : "done",
            durationMs: null,
            startedAt,
            endedAt: startedAt,
          });
        }
        // thinking 块 v1 丢弃。
      }
    }

    const parentTurn = start.parentUuid ? ownerTurn(start.parentUuid) : null;
    turns.push({
      id,
      parentId: parentTurn,
      siblingIndex: 0, // 下面按 parent 分组回填
      question: userText(start) ?? "",
      response: textParts.join("\n\n"),
      toolCalls,
      tokens: {
        input: lastUsage?.input_tokens ?? 0,
        output: lastUsage?.output_tokens ?? 0,
        cacheRead: lastUsage?.cache_read_input_tokens ?? 0,
        cacheCreation: lastUsage?.cache_creation_input_tokens ?? 0,
        contextTokens: lastUsage
          ? (lastUsage.input_tokens ?? 0) +
            (lastUsage.cache_read_input_tokens ?? 0) +
            (lastUsage.cache_creation_input_tokens ?? 0)
          : null,
      },
      createdAt: ms(start.timestamp),
    });
  }

  // siblingIndex：同 parent 下按 createdAt 排序赋序号。
  const byParent = new Map<string | null, ParsedTurn[]>();
  for (const t of turns) {
    (byParent.get(t.parentId) ?? byParent.set(t.parentId, []).get(t.parentId)!).push(t);
  }
  for (const group of byParent.values()) {
    group.sort((a, b) => a.createdAt - b.createdAt);
    group.forEach((t, i) => (t.siblingIndex = i));
  }

  if (turns.length === 0) return null;

  const times = turns.map((t) => t.createdAt).filter((t) => t > 0);
  const title =
    aiTitle ??
    (turns[0].question.replace(/\s+/g, " ").trim().slice(0, 60) || "未命名会话");

  const lastUuid =
    [...all].reverse().find((e) => typeof e.uuid === "string")?.uuid ?? null;

  return {
    sessionId,
    cwd,
    gitBranch,
    title,
    createdAt: times.length ? Math.min(...times) : 0,
    updatedAt: times.length ? Math.max(...times) : 0,
    lastUuid,
    turns,
  };
}
