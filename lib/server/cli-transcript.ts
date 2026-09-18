import fs from "node:fs";
import path from "node:path";
import type { ParsedCliSession } from "./cli-import";
import { parseCliSessionJsonl } from "./cli-import";
import { parseCodexSessionJsonl } from "./codex-import";

export type CliProvider = "claude" | "codex";

/** Keep sync/import callers provider-agnostic without changing Claude parsing. */
export function parseCliTranscript(
  provider: CliProvider,
  jsonlPath: string,
): ParsedCliSession | null {
  return provider === "codex"
    ? parseCodexSessionJsonl(jsonlPath)
    : parseCliSessionJsonl(jsonlPath);
}

// ── transcript 三态 ─────────────────────────────────────────────────────────
//
// 一个 transcript 只有三种结局，**「读到了但没内容」和「读不到」必须分开**：
//   ready      有可解析轮次
//   empty      读到了，但没有轮次 —— 合法的零轮次会话（只有 mode /
//              file-history-snapshot / slash-command 噪声行）。确定性结果，
//              重试一万次也一样。
//   unreadable 打不开（ENOENT / EACCES / EIO / EISDIR …）或有坏行（CLI 可能
//              正写到一半）。这意味着我们对这条 transcript 的 turn 集合
//              **一无所知**，是**临时**状态，值得下一轮再试。
//
// 关键：**不能拿 parseCliTranscript 返回 null 当「读不到」的判据** —— 合法空会话
// 同样返回 null（cli-import.ts:131 与 :328），两者只能靠文件本身分开。
// 这条判据的另一面在 cli-import-db.ts:parseLineagesChecked：拿残缺的 turn 集合去做
// 「不在集合里就删」的清理，会把整条 lineage 的节点剥掉。

export type CliTranscriptState =
  | { kind: "ready"; parsed: ParsedCliSession }
  | { kind: "empty"; sessionId: string }
  | { kind: "unreadable" };

/** 「格式合法」= 打得开，且每一非空行都是合法 JSON。全部看文件结构，不看 error
 * message 字符串 —— 驱动换实现时字符串判据迟早会错。 */
export function readsAsJsonLines(file: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return false; // ENOENT / EACCES / EIO / EISDIR 一视同仁：读不到
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * 分类一次**已经拿到**的解析结果。拆成这个形状是为了让异步解析路径
 * （watcher / 启动补齐的分片解析）能复用同一套判据而不必重新解析一遍。
 */
export function classifyParsedTranscript(
  file: string,
  parsed: ParsedCliSession | null,
): CliTranscriptState {
  if (parsed && parsed.turns.length > 0) return { kind: "ready", parsed };
  if (!readsAsJsonLines(file)) return { kind: "unreadable" };
  return {
    kind: "empty",
    sessionId: parsed?.sessionId ?? path.basename(file).replace(/\.jsonl$/, ""),
  };
}

/** 解析 + 分类的一步到位版本（同步路径用）。 */
export function classifyCliTranscript(
  provider: CliProvider,
  file: string,
): CliTranscriptState {
  return classifyParsedTranscript(file, parseCliTranscript(provider, file));
}
