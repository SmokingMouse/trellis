// transcript 尾扫：Stop 事件没带 last_assistant_message 时的兜底。
//
// 为什么倒着分块读而不是整文件读：一个长会话的 jsonl 能到几十 MB，而我们只要
// 最后一条 assistant 文本。hook 挂在 Claude 的 Stop 上，读文件的耗时会直接变成
// 用户看到的停顿 —— 所以从文件尾往前 64KB 一块地读，找到就停，最多读 256KB。
import { closeSync, openSync, readSync, statSync } from "node:fs";

const CHUNK_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 256 * 1024;

/** 从一行 jsonl 里抠出 assistant 的纯文本；不是 assistant / 没文本 → null。 */
export function assistantTextFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let entry: unknown;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  if (e.isSidechain === true) return null;
  const message = (e.message ?? e) as Record<string, unknown>;
  const role = message.role ?? e.type;
  if (role !== "assistant") return null;

  const content = message.content;
  if (typeof content === "string") {
    return content.trim() || null;
  }
  if (Array.isArray(content)) {
    const text = content
      .filter(
        (b): b is { type: string; text: string } =>
          Boolean(b) &&
          typeof b === "object" &&
          (b as { type?: unknown }).type === "text" &&
          typeof (b as { text?: unknown }).text === "string",
      )
      .map((b) => b.text)
      .join("")
      .trim();
    return text || null;
  }
  return null;
}

/**
 * 读 transcript 尾部，取最后一条 assistant 文本。
 * 文件不存在 / 读不动 / 256KB 内没有 → null（这是兜底，失败就当没有）。
 */
export function readLastAssistantMessage(file: string): string | null {
  let fd: number | null = null;
  try {
    const size = statSync(file).size;
    if (size <= 0) return null;
    fd = openSync(file, "r");

    let end = size;
    let consumed = 0;
    let buf = Buffer.alloc(0);

    while (end > 0 && consumed < MAX_TAIL_BYTES) {
      const len = Math.min(CHUNK_BYTES, end, MAX_TAIL_BYTES - consumed);
      const start = end - len;
      const chunk = Buffer.alloc(len);
      readSync(fd, chunk, 0, len, start);
      buf = Buffer.concat([chunk, buf]);
      end = start;
      consumed += len;

      const lines = buf.toString("utf8").split("\n");
      // 首行在块边界上多半是半条 —— 只有真读到文件开头时它才完整。
      const floor = end === 0 ? 0 : 1;
      for (let i = lines.length - 1; i >= floor; i--) {
        const text = assistantTextFromLine(lines[i]);
        if (text) return text;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* 关不上也没什么可做的 */
      }
    }
  }
}
