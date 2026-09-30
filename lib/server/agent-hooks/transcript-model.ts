// 窗格当前模型：Claude 的 jsonl 里最近一条（非 sidechain）assistant 行的 message.model。
// 给 Herdr 输入框的只读模型 chip 用；拿不到就是 null（chip 不显示）。
//
// 读法与 transcript-pending.ts 相同：只读文件尾，按 (size, mtime) 缓存。
// `<synthetic>` 是 Claude Code 自己合成的消息（报错 / 中断提示），不算模型。
import { statSync } from "node:fs";
import { readTranscriptTailLines } from "./transcript-pending";

export const TRANSCRIPT_MODEL_TAIL_BYTES = 256 * 1024;

export function findLastAssistantModel(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    // 便宜的预筛：绝大多数行不是 assistant，不值得 JSON.parse
    if (!line.startsWith("{") || !line.includes('"assistant"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "assistant" || record.isSidechain === true) continue;
    const message = record.message as Record<string, unknown> | undefined;
    const model = message && typeof message === "object" ? message.model : undefined;
    if (typeof model !== "string") continue;
    const trimmed = model.trim();
    if (!trimmed || trimmed === "<synthetic>") continue;
    return trimmed;
  }
  return null;
}

export function readTranscriptModel(file: string, maxBytes = TRANSCRIPT_MODEL_TAIL_BYTES): string | null {
  return findLastAssistantModel(readTranscriptTailLines(file, maxBytes));
}

const CACHE_MAX = 256;

export class TranscriptModelCache {
  private readonly entries = new Map<string, { signature: string; model: string | null }>();

  constructor(private readonly read: (file: string) => string | null = readTranscriptModel) {}

  get(file: string): string | null {
    let signature: string;
    try {
      const stat = statSync(file);
      signature = `${stat.size}:${stat.mtimeMs}`;
    } catch {
      this.entries.delete(file);
      return null;
    }
    const hit = this.entries.get(file);
    if (hit && hit.signature === signature) return hit.model;
    const model = this.read(file);
    this.entries.delete(file);
    if (this.entries.size >= CACHE_MAX) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(file, { signature, model });
    return model;
  }
}
