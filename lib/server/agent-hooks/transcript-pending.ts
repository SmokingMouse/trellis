// transcript 待答提取：Claude 的 jsonl 里「有 tool_use、还没有对应 tool_result」的那条
// 就是窗格此刻卡着等人的请求（AskUserQuestion 提问 / 权限审批）。
//
// 数据源优先级 hook > transcript > 读屏：hook 装之前起的进程、hook 记录丢了时，
// 这里比从终端文本反推选项可靠得多 —— input 是 Claude 自己写下的完整结构。
//
// 只读文件尾（默认 512KB），不整读：长会话 jsonl 能到几十 MB。
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { approvalSummary } from "./normalize";

export const TRANSCRIPT_PENDING_TAIL_BYTES = 512 * 1024;

const ASK_USER_QUESTION = "AskUserQuestion";
/** 子 agent 的外壳工具：它未完成只说明子 agent 在跑，卡住的是子 agent 里的某一步 —— 交给读屏。 */
const DELEGATING_TOOLS = new Set(["Task", "Agent"]);

export type PendingToolUse = {
  id: string;
  name: string;
  input: unknown;
};

/** 和 hook 路径（normalize.ts）同一形状的 interactivePrompt，外加定位用的 tool_use_id。 */
export type TranscriptPrompt = {
  toolUseId: string;
  toolName: string;
  interactivePrompt: Record<string, unknown>;
};

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function parseLine(line: string): Json | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return asObject(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/**
 * 扫一段 jsonl 行，返回「最后一条 assistant 消息」里仍未完成的 tool_use（按出现顺序）。
 *
 * - sidechain 行（旧版把子 agent 写进主文件）一律跳过；
 * - 同一条 assistant 消息被流式拆成多行（thinking / text / tool_use 各一行，message.id 相同），
 *   按 message.id 归并；同一个 tool_use id 重复出现只算一次；
 * - tool_result 在后续 user 行里，按 tool_use_id 销账；
 * - 之后出现了人的新输入（非 meta 的 user 文本，含「[Request interrupted …]」）→ 之前的全部作废；
 * - 只看最后一条 assistant 消息：Claude 不会在还有未完成调用时开新一轮，旧消息里的残留是中断遗留。
 */
export function findPendingToolUses(lines: string[]): PendingToolUse[] {
  const uses = new Map<string, PendingToolUse & { messageId: string }>();
  const resolved = new Set<string>();
  let lastMessageId: string | null = null;

  for (const line of lines) {
    const entry = parseLine(line);
    if (!entry || entry.isSidechain === true) continue;
    const message = asObject(entry.message);
    if (!message) continue;
    const content = message.content;

    if (entry.type === "assistant") {
      const messageId = typeof message.id === "string" ? message.id : typeof entry.uuid === "string" ? entry.uuid : null;
      if (!messageId) continue;
      lastMessageId = messageId;
      if (!Array.isArray(content)) continue;
      for (const raw of content) {
        const block = asObject(raw);
        if (block?.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") continue;
        if (!uses.has(block.id)) uses.set(block.id, { id: block.id, name: block.name, input: block.input ?? null, messageId });
      }
      continue;
    }

    if (entry.type === "user") {
      if (entry.isMeta === true || entry.isCompactSummary === true) continue;
      if (typeof content === "string") {
        if (content.trim()) uses.clear();
        continue;
      }
      if (!Array.isArray(content)) continue;
      let humanText = false;
      for (const raw of content) {
        const block = asObject(raw);
        if (!block) continue;
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") resolved.add(block.tool_use_id);
        else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) humanText = true;
      }
      // tool_result 行也可能带 text 块（hook 反馈 / 图片说明），只有纯人话才是新一轮
      if (humanText && !content.some((raw) => asObject(raw)?.type === "tool_result")) uses.clear();
    }
  }

  if (!lastMessageId) return [];
  return [...uses.values()]
    .filter((use) => use.messageId === lastMessageId && !resolved.has(use.id))
    .map(({ id, name, input }) => ({ id, name, input }));
}

/**
 * 未完成的 tool_use → 待答卡。
 *   AskUserQuestion → 结构化提问（tool_input 原样，同 hook 路径）；
 *   其它工具 → 权限审批卡（仅当调用方确认窗格 blocked 时才有意义，本函数不判断窗格状态）；
 *   子 agent 外壳 / 多个普通工具同时悬着（认不出是哪个在等批准）→ null，交给读屏。
 */
export function pendingToPrompt(pending: PendingToolUse[]): TranscriptPrompt | null {
  if (pending.length === 0) return null;
  const ask = [...pending].reverse().find((use) => use.name === ASK_USER_QUESTION);
  if (ask) {
    const input = asObject(ask.input);
    if (!input || !Array.isArray(input.questions) || input.questions.length === 0) return null;
    return {
      toolUseId: ask.id,
      toolName: ask.name,
      interactivePrompt: { ...input, tool_name: ask.name, tool_use_id: ask.id },
    };
  }
  if (pending.length !== 1) return null;
  const [use] = pending;
  if (DELEGATING_TOOLS.has(use.name)) return null;
  return {
    toolUseId: use.id,
    toolName: use.name,
    interactivePrompt: {
      approval: { tool: use.name, summary: approvalSummary({ tool_name: use.name, tool_input: use.input }) },
      tool_name: use.name,
      tool_use_id: use.id,
    },
  };
}

/** 读文件最后 maxBytes 字节，按行切；没读到文件头时丢掉被切断的首行。 */
export function readTranscriptTailLines(file: string, maxBytes = TRANSCRIPT_PENDING_TAIL_BYTES): string[] {
  let fd: number | null = null;
  try {
    const size = statSync(file).size;
    if (size <= 0) return [];
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fd = openSync(file, "r");
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    return len < size ? lines.slice(1) : lines;
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* 只读句柄，关不上也无害 */
      }
    }
  }
}

export function readTranscriptPrompt(file: string, maxBytes = TRANSCRIPT_PENDING_TAIL_BYTES): TranscriptPrompt | null {
  return pendingToPrompt(findPendingToolUses(readTranscriptTailLines(file, maxBytes)));
}

const CACHE_MAX = 256;

/** 以 (size, mtime) 为失效键的缓存：fleet 每 2.5 秒被轮询，文件没动就不重读。 */
export class TranscriptPromptCache {
  private readonly entries = new Map<string, { signature: string; prompt: TranscriptPrompt | null }>();

  constructor(private readonly read: (file: string) => TranscriptPrompt | null = readTranscriptPrompt) {}

  get(file: string): TranscriptPrompt | null {
    let signature: string;
    try {
      const stat = statSync(file);
      signature = `${stat.size}:${stat.mtimeMs}`;
    } catch {
      this.entries.delete(file);
      return null;
    }
    const hit = this.entries.get(file);
    if (hit && hit.signature === signature) return hit.prompt;
    const prompt = this.read(file);
    this.entries.delete(file);
    if (this.entries.size >= CACHE_MAX) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(file, { signature, prompt });
    return prompt;
  }
}
