import { spawn } from "node:child_process";
import os from "node:os";
import type {
  LLMProvider,
  Mode,
  StreamEvent,
  StreamRequest,
} from "./types";
import { DEFAULT_SYSTEM_PROMPT, buildPrompt } from "./prompt";

export type ClaudeModel = "opus" | "sonnet" | "haiku";

export function makeClaudeProvider(
  opts: { model?: ClaudeModel; mode?: Mode } = {},
): LLMProvider {
  const mode: Mode = opts.mode ?? "lean";
  return {
    async *stream({
      history,
      question,
      parentAnchor,
      signal,
      claudeSessionId,
    }: StreamRequest): AsyncGenerator<StreamEvent> {
      // Three modes diverge in how the prompt + flags are constructed:
      //   lean       → folded history + override system prompt + tools off
      //   cli-single → folded history + CLI defaults (skills/CLAUDE.md/tools)
      //                + bypassPermissions, cwd ~. Stateless per turn.
      //   cli-multi  → only the current question goes to claude (history
      //                lives in the resumed claude session). bypassPermissions
      //                + persistence on. Linear turn history per trellis
      //                session, see lib/server/repo.ts:claudeSessionPath.
      const promptText =
        mode === "cli-multi"
          ? buildCliMultiPrompt(question, parentAnchor)
          : buildPrompt(history, question, parentAnchor);

      const args: string[] = [
        "-p",
        promptText,
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--model",
        opts.model ?? "sonnet",
        "--verbose",
      ];

      if (mode === "lean") {
        args.push("--no-session-persistence");
        args.push("--tools", "");
        args.push("--system-prompt", DEFAULT_SYSTEM_PROMPT);
      } else if (mode === "cli-single") {
        args.push("--no-session-persistence");
        args.push("--permission-mode", "bypassPermissions");
      } else {
        // cli-multi: keep persistence so resume works; either resume an
        // existing session or let claude generate a fresh id (we read it
        // from system/init below and emit session_init upstream).
        args.push("--permission-mode", "bypassPermissions");
        if (claudeSessionId) {
          args.push("--resume", claudeSessionId);
        }
      }

      const proc = spawn("claude", args, {
        cwd: mode === "lean" ? os.tmpdir() : os.homedir(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      const onAbort = () => proc.kill("SIGTERM");
      signal?.addEventListener("abort", onAbort);

      const stderrChunks: Buffer[] = [];
      proc.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

      try {
        let buffer = "";
        let yielded = false;
        for await (const chunk of proc.stdout) {
          buffer += chunk.toString();
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            const event = safeParse(line);
            if (!event) continue;

            // First event in stream: system/init carries the session_id we
            // need to persist for cli-multi resume on the next turn. Emit it
            // unconditionally; route handler decides whether to record.
            if (
              event.type === "system" &&
              event.subtype === "init" &&
              typeof event.session_id === "string"
            ) {
              yield { type: "session_init", sessionId: event.session_id };
              continue;
            }

            // Streaming text deltas
            if (
              event.type === "stream_event" &&
              event.event?.type === "content_block_delta" &&
              event.event?.delta?.type === "text_delta"
            ) {
              const delta = event.event.delta.text;
              if (typeof delta === "string" && delta.length > 0) {
                yield { type: "delta", text: delta };
                yielded = true;
              }
              continue;
            }

            // Final result event with totals
            if (event.type === "result") {
              if (event.is_error) {
                yield {
                  type: "error",
                  message: event.result ?? "claude CLI error",
                };
                return;
              }
              const u = event.usage ?? {};
              yield {
                type: "done",
                usage: {
                  input: u.input_tokens ?? 0,
                  output: u.output_tokens ?? 0,
                  cacheRead: u.cache_read_input_tokens ?? 0,
                  cacheCreation: u.cache_creation_input_tokens ?? 0,
                },
              };
              return;
            }

            // Surface error events
            if (event.type === "error" || event.type === "system_error") {
              yield {
                type: "error",
                message: event.message ?? event.error ?? "unknown error",
              };
              return;
            }
          }
        }

        // Stream ended without a result event
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        if (!yielded) {
          yield {
            type: "error",
            message: stderr || `claude exited with code ${proc.exitCode ?? "?"}`,
          };
        } else {
          yield {
            type: "done",
            usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
          };
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        if (!proc.killed) proc.kill("SIGTERM");
      }
    },
  };
}

// In cli-multi mode, history is already in the resumed claude session — we
// only send the current turn's question (plus an optional anchor preface).
function buildCliMultiPrompt(
  question: string,
  parentAnchor?: { selectedText: string } | null,
): string {
  if (parentAnchor?.selectedText) {
    return `从你上一段中我选中了「${parentAnchor.selectedText}」，继续问：${question}`;
  }
  return question;
}

function safeParse(line: string): Record<string, unknown> & {
  type?: string;
  subtype?: string;
  session_id?: string;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  result?: string;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
  is_error?: boolean;
  message?: string;
  error?: string;
} | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
