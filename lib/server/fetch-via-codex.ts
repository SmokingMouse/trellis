import "server-only";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import type { ReferenceMeta } from "@/lib/types";
import { buildFetchPrompt, parseFetchOutput } from "./fetch-prompt";

// URL → markdown via codex CLI, streaming progress.
//
// Mirror of fetch-via-claude.ts but for `codex exec --json`. Same FetchEvent
// shape, same prompt envelope, same parser — only the spawn args and JSONL
// schema differ.
//
// codex CLI 0.125 quirks (also see lib/llm/codex.ts):
//   * agent_message arrives as one `item.completed` event with the full text;
//     no streaming deltas. We surface a single "整理 markdown…" progress event
//     when text starts arriving so the spinner doesn't look frozen.
//   * tool calls show up as `item.started` / `item.completed` events with
//     type "command_execution". We forward the command line as progress.
//   * stderr occasionally has "failed to record rollout items" — non-fatal,
//     ignore.
//   * `--dangerously-bypass-approvals-and-sandbox` is required so codex can
//     spawn `feishu-cli`, `curl`, `yt-dlp`, etc. on the user's behalf.
//   * Always uses ChatGPT subscription auth (no `--ignore-user-config`).

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const FETCH_MODEL = "gpt-5.5";

export type FetchEvent =
  | { type: "progress"; message: string }
  | { type: "result"; contentMd: string; meta: ReferenceMeta }
  | { type: "error"; message: string };

export async function* fetchUrlViaCodex(
  url: string,
  signal?: AbortSignal,
): AsyncGenerator<FetchEvent> {
  const loginCheck = spawnSync("codex", ["login", "status"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (loginCheck.status !== 0) {
    yield {
      type: "error",
      message:
        "codex 未登录。请先在终端运行 `codex login` 完成 ChatGPT 订阅或 API key 登录后重试。",
    };
    return;
  }

  const prompt = buildFetchPrompt(url);
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--dangerously-bypass-approvals-and-sandbox",
    "-m",
    FETCH_MODEL,
    prompt,
  ];

  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn("codex", args, {
      cwd: os.tmpdir(),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    yield {
      type: "error",
      message: `spawn codex 失败：${err instanceof Error ? err.message : String(err)}`,
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

  let stdoutBytes = 0;
  let buffer = "";
  let assistantText = "";
  let yielded = false;
  let resultEmitted = false;
  let assemblingNotified = false;

  try {
    for await (const chunk of proc.stdout!) {
      if (stdoutBytes >= MAX_OUTPUT_BYTES) {
        proc.kill("SIGTERM");
        yield {
          type: "error",
          message: `codex 输出超过 ${MAX_OUTPUT_BYTES / 1024 / 1024} MB，已强制中止`,
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

        // Surface tool calls (Bash commands codex is running on user's
        // behalf) as progress events.
        if (event.type === "item.started") {
          const item = event.item as
            | { type?: string; command?: string }
            | undefined;
          if (item?.type === "command_execution" && item.command) {
            yield {
              type: "progress",
              message: `运行 \`${truncate(item.command, 70)}\``,
            };
            yielded = true;
          }
          continue;
        }

        // agent_message text arrives all at once. Tap it on the first
        // sighting to flip the "assembling" notice, and again on completed
        // to capture the final string.
        if (
          (event.type === "item.updated" ||
            event.type === "item.completed") &&
          isAgentMessage(event.item)
        ) {
          const item = event.item as { text?: string };
          assistantText = item.text ?? assistantText;
          if (assistantText && !assemblingNotified) {
            assemblingNotified = true;
            yield { type: "progress", message: "整理 markdown…" };
            yielded = true;
          }
          continue;
        }

        if (event.type === "turn.completed") {
          const parsed = parseFetchOutput(assistantText, url);
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

        if (event.type === "turn.failed") {
          const errObj = event.error as { message?: string } | undefined;
          yield {
            type: "error",
            message: errObj?.message ?? "codex turn failed",
          };
          return;
        }

        if (event.type === "error") {
          const msg = (event.message as string) ?? "";
          if (!msg.toLowerCase().startsWith("reconnecting")) {
            yield { type: "error", message: msg || "codex error" };
            return;
          }
          continue;
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
    } else if (assistantText.trim()) {
      const parsed = parseFetchOutput(assistantText, url);
      yield {
        type: "result",
        contentMd: parsed.contentMd,
        meta: {
          title: parsed.title,
          platform: parsed.platform,
          wordCount: parsed.contentMd.length || undefined,
          fetchError: parsed.fetchError ?? "codex 提前退出，输出可能不完整",
        },
      };
    } else {
      const tail = stderr.slice(-400);
      yield {
        type: "error",
        message:
          tail || `codex 退出（exit ${proc.exitCode ?? "?"}），无错误输出`,
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

function isAgentMessage(item: unknown): boolean {
  return (
    typeof item === "object" &&
    item !== null &&
    (item as { type?: string }).type === "agent_message"
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
