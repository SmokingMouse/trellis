import "server-only";
import { spawn } from "node:child_process";
import os from "node:os";
import type { ReferenceMeta } from "@/lib/types";
import { buildFetchPrompt, parseFetchOutput } from "./fetch-prompt";

// URL → markdown via claude CLI, streaming progress.
//
// Implemented as an async generator so the API route can forward each
// progress message to the browser as an SSE event in near real time.
// The user sees what claude is doing (which skill it picked, when the
// tool finished, when markdown is being assembled) instead of staring
// at "处理中…" for 30s.
//
// No timeout — long-running skills (feishu-cli on big wikis, YouTube
// transcripts on long videos) can legitimately take several minutes.
// The SSE connection itself is the deadline: when the user closes the
// browser or aborts, the spawn signal kills claude.

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

export type FetchEvent =
  | { type: "progress"; message: string }
  | { type: "result"; contentMd: string; meta: ReferenceMeta }
  | { type: "error"; message: string };

export async function* fetchUrlViaClaude(
  url: string,
  signal?: AbortSignal,
): AsyncGenerator<FetchEvent> {
  const prompt = buildFetchPrompt(url);
  const args = [
    "-p",
    prompt,
    "--permission-mode",
    "bypassPermissions",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    // sonnet, not haiku: haiku tends to "improve" fetched content by
    // adding ## Overview / **Summary** sections even when the prompt
    // explicitly forbids it. sonnet follows verbatim instructions more
    // reliably. Cost goes from ~$0.01/fetch → ~$0.05/fetch — acceptable
    // for the fidelity gain.
    "--model",
    "sonnet",
    "--verbose",
  ];

  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn("claude", args, {
      cwd: os.tmpdir(),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    yield {
      type: "error",
      message: `spawn claude 失败：${err instanceof Error ? err.message : String(err)}`,
    };
    return;
  }

  const onAbort = () => proc.kill("SIGTERM");
  signal?.addEventListener("abort", onAbort);

  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  proc.stderr?.on("data", (c: Buffer) => {
    if (stderrBytes < 64 * 1024) {
      stderrChunks.push(c);
      stderrBytes += c.length;
    }
  });

  // Stream-json parsing state
  let stdoutBytes = 0;
  let buffer = "";
  // Each tool_use content block has its own input JSON streamed via
  // input_json_delta. Keyed by index so we don't mix them up.
  const toolInputBuffers = new Map<number, string>();
  const toolNames = new Map<number, string>();
  let assistantTextBuffer = "";
  let yielded = false;
  let resultEmitted = false;
  // Show "整理 markdown…" only once even though many text_delta events fire.
  let assemblingNotified = false;

  try {
    for await (const chunk of proc.stdout!) {
      if (stdoutBytes >= MAX_OUTPUT_BYTES) {
        proc.kill("SIGTERM");
        yield {
          type: "error",
          message: `claude 输出超过 ${MAX_OUTPUT_BYTES / 1024 / 1024} MB，已强制中止`,
        };
        return;
      }
      stdoutBytes += chunk.length;
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const event = safeParse(line);
        if (!event) continue;

        // Errors / aborted sub-process
        if (event.type === "error" || event.type === "system_error") {
          const msg =
            (event.message as string) ??
            (event.error as string) ??
            "claude error";
          yield { type: "error", message: msg };
          return;
        }

        if (event.type === "result") {
          if (event.is_error) {
            const msg = (event.result as string) ?? "claude 内部错误";
            yield { type: "error", message: msg };
            return;
          }
          const parsed = parseFetchOutput(assistantTextBuffer, url);
          yield {
            type: "result",
            contentMd: parsed.contentMd,
            meta: {
              title: parsed.title,
              platform: parsed.platform,
              wordCount: parsed.contentMd.length || undefined,
              fetchError: parsed.fetchError,
            },
          };
          resultEmitted = true;
          return;
        }

        if (event.type !== "stream_event") continue;
        const sub = event.event as Record<string, unknown> | undefined;
        if (!sub) continue;

        if (sub.type === "content_block_start") {
          const cb = sub.content_block as
            | { type?: string; name?: string; input?: unknown; index?: number }
            | undefined;
          const blockIdx = (sub.index as number | undefined) ?? -1;
          if (cb?.type === "thinking") {
            // Suppress per-block thinking notice — gets noisy on a single
            // request. Only the first thinking block is interesting.
            if (!yielded) {
              yield { type: "progress", message: "推理中…" };
              yielded = true;
            }
          } else if (cb?.type === "tool_use") {
            toolNames.set(blockIdx, cb.name ?? "tool");
            toolInputBuffers.set(blockIdx, "");
            yield {
              type: "progress",
              message: `调用工具 ${cb.name ?? "tool"} …`,
            };
            yielded = true;
          } else if (cb?.type === "text") {
            // Final assistant text starts here. Reset buffer (claude
            // emits multiple text blocks across thinking/tool turns —
            // we want the final one).
            assistantTextBuffer = "";
          }
        } else if (sub.type === "content_block_delta") {
          const delta = sub.delta as
            | {
                type?: string;
                text?: string;
                partial_json?: string;
              }
            | undefined;
          const blockIdx = (sub.index as number | undefined) ?? -1;
          if (delta?.type === "input_json_delta" && delta.partial_json) {
            // Tool input streams in piece by piece as JSON fragments.
            // Once we can extract a meaningful parameter (Bash command /
            // URL being fetched / file path / search query), surface it
            // to the user. Skip subsequent updates for the same block —
            // one informative line per tool call is enough.
            const prev = toolInputBuffers.get(blockIdx) ?? "";
            if (prev === SNIFF_DONE) continue;
            const buf = prev + delta.partial_json;
            toolInputBuffers.set(blockIdx, buf);
            const tname = toolNames.get(blockIdx) ?? "tool";
            const sniffed = sniffToolInput(buf, tname);
            if (sniffed) {
              yield {
                type: "progress",
                message: formatToolProgress(tname, sniffed),
              };
              toolInputBuffers.set(blockIdx, SNIFF_DONE);
            }
          } else if (delta?.type === "text_delta") {
            assistantTextBuffer += delta.text ?? "";
            if (!assemblingNotified) {
              assemblingNotified = true;
              yield { type: "progress", message: "整理 markdown…" };
            }
          }
        } else if (sub.type === "content_block_stop") {
          // For tool_use blocks, the actual tool execution + tool_result
          // arrives as a separate top-level "user" event. We don't need
          // to emit progress here — the next phase (next thinking /
          // text) will do it.
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!proc.killed) proc.kill("SIGTERM");
  }

  if (!resultEmitted) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    if (signal?.aborted) {
      yield { type: "error", message: "已取消" };
    } else if (assistantTextBuffer.trim()) {
      // Claude exited without a result event but wrote text — parse what
      // we have. New parser is total (no null path), so any partial
      // output still becomes a usable card.
      const parsed = parseFetchOutput(assistantTextBuffer, url);
      yield {
        type: "result",
        contentMd: parsed.contentMd,
        meta: {
          title: parsed.title,
          platform: parsed.platform,
          wordCount: parsed.contentMd.length || undefined,
          fetchError: parsed.fetchError ?? "claude 提前退出，输出可能不完整",
        },
      };
    } else {
      const tail = stderr.slice(-400);
      yield {
        type: "error",
        message:
          tail || `claude 退出（exit ${proc.exitCode ?? "?"}），无错误输出`,
      };
    }
  }
}

function safeParse(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// Sentinel: marks a tool block whose input we've already announced, so
// later input_json_delta chunks for the same block don't re-trigger the
// progress message.
const SNIFF_DONE = " done ";

// Per-tool best-effort extractor: pulls the most informative scalar out
// of a partial JSON input stream. We don't fully parse — just grep the
// canonical key for each tool. Subset of common tools we care about
// during reference fetching.
function sniffToolInput(partial: string, toolName: string): string | null {
  // Tool name → preferred keys to inspect, in order of relevance.
  const keys = ((): string[] => {
    switch (toolName) {
      case "Bash":
        return ["command"];
      case "WebFetch":
        return ["url"];
      case "WebSearch":
        return ["query"];
      case "Read":
      case "Write":
      case "Edit":
        return ["file_path", "path"];
      case "Grep":
      case "Glob":
        return ["pattern", "query"];
      default:
        return ["url", "command", "query", "file_path", "path", "input"];
    }
  })();
  for (const key of keys) {
    // Match either a complete `"key":"value"` (preferred) or an
    // in-progress `"key":"value...` so we can show something while the
    // full token streams. Wait for ≥20 chars of value so URLs that
    // start with "https://" have a domain visible — saves the user
    // from staring at "抓取 https://" with no host.
    const completeRe = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`);
    const partialRe = new RegExp(`"${key}"\\s*:\\s*"([^"]*)`);
    const complete = completeRe.exec(partial);
    if (complete) {
      const value = complete[1].replace(/\\n/g, " ").trim();
      if (value.length >= 1) return value;
      continue;
    }
    const m = partialRe.exec(partial);
    if (!m) continue;
    const value = m[1].replace(/\\n/g, " ").trim();
    if (value.length >= 20) return value;
  }
  return null;
}

function formatToolProgress(toolName: string, sniffed: string): string {
  const short = truncate(sniffed, 70);
  switch (toolName) {
    case "Bash":
      return `运行 \`${short}\``;
    case "WebFetch":
      return `抓取 ${short}`;
    case "WebSearch":
      return `搜索 ${short}`;
    case "Read":
      return `读取 ${short}`;
    case "Grep":
    case "Glob":
      return `匹配 ${short}`;
    default:
      return `${toolName}: ${short}`;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// Frontmatter parser is shared with the codex fetcher — see fetch-prompt.ts.
