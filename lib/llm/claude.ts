import { spawn } from "node:child_process";
import fs from "node:fs";
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
  const mode: Mode = opts.mode ?? "chat";
  return {
    async *stream({
      history,
      question,
      parentAnchor,
      signal,
      claudeSessionId,
      cwd,
      attachments,
    }: StreamRequest): AsyncGenerator<StreamEvent> {
      // Three modes diverge in how the prompt + flags are constructed:
      //   chat      → folded history + override system prompt + only
      //               WebSearch/WebFetch tools. cwd ~ (no workspace).
      //   workspace → folded history + CLI defaults (skills/CLAUDE.md/tools)
      //               + bypassPermissions, cwd = session.workspace_path.
      //               Stateless per turn.
      //   project   → only the current question goes to claude (history
      //               lives in the resumed claude session). bypassPermissions
      //               + persistence on. Linear turn history per trellis
      //               session, see lib/server/repo.ts:claudeSessionPath.
      const promptText =
        mode === "project"
          ? buildProjectPrompt(question, parentAnchor)
          : buildPrompt(history, question, parentAnchor);

      // Stage 15: when the turn has image attachments, we can't use the
      // -p flag (claude accepts text only there). Switch to stdin
      // stream-json input — claude reads a JSONL user message that
      // carries both image and text content blocks. Same prompt text
      // (buildPrompt result) just rewrapped as a content block.
      const hasImages = (attachments?.length ?? 0) > 0;

      const args: string[] = [
        ...(hasImages
          ? ["--input-format", "stream-json"]
          : ["-p", promptText]),
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--model",
        opts.model ?? "sonnet",
        "--verbose",
      ];

      if (mode === "chat") {
        args.push("--no-session-persistence");
        // Chat mode whitelists web tools so the model can fact-check / fetch
        // links (the only thing GPT web clients can do that pure lean couldn't).
        args.push("--tools", "WebSearch,WebFetch");
        args.push("--system-prompt", DEFAULT_SYSTEM_PROMPT);
      } else if (mode === "workspace") {
        args.push("--no-session-persistence");
        args.push("--permission-mode", "bypassPermissions");
      } else {
        // project: keep persistence so resume works; either resume an
        // existing session or let claude generate a fresh id (we read it
        // from system/init below and emit session_init upstream).
        args.push("--permission-mode", "bypassPermissions");
        if (claudeSessionId) {
          args.push("--resume", claudeSessionId);
        }
      }

      // chat → always home (no workspace concept).
      // workspace/project → cwd from session.workspace_path; fallback to
      // home if missing so the spawn doesn't crash. Repo layer is the
      // source of truth for which path lands here.
      const spawnCwd = mode === "chat" ? os.homedir() : (cwd ?? os.homedir());
      const proc = spawn("claude", args, {
        cwd: spawnCwd,
        // stdin needs to be a pipe only when we're feeding stream-json
        // input. Otherwise leave it ignored so claude doesn't block on
        // an EOF that never comes from us.
        stdio: [hasImages ? "pipe" : "ignore", "pipe", "pipe"],
      });

      if (hasImages && proc.stdin) {
        // Build one user message that carries every image as an
        // {type:"image",...} content block, followed by the prompt
        // text. claude's stream-json input handles the same content
        // shape that the Anthropic Messages API takes.
        const content = [
          ...(attachments ?? []).map((a) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: a.mime,
              data: fs.readFileSync(a.path).toString("base64"),
            },
          })),
          { type: "text" as const, text: promptText },
        ];
        const userMessage = {
          type: "user",
          message: { role: "user", content },
        };
        proc.stdin.write(JSON.stringify(userMessage) + "\n");
        proc.stdin.end();
      }

      const onAbort = () => proc.kill("SIGTERM");
      signal?.addEventListener("abort", onAbort);

      // stdio is always [_, "pipe", "pipe"] — stdin alone varies. TS
      // can't narrow the union from the conditional, so assert here.
      const stderr = proc.stderr!;
      const stdout = proc.stdout!;

      const stderrChunks: Buffer[] = [];
      stderr.on("data", (c: Buffer) => stderrChunks.push(c));

      try {
        let buffer = "";
        let yielded = false;
        for await (const chunk of stdout) {
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

            // Stage 17: tool_use blocks arrive inside the consolidated
            // assistant event (one per turn slice). Each block is a
            // complete tool invocation — id + name + input — that the
            // model decided on. We emit a tool_call_start with what we
            // have; the matching tool_result (or our own SIGTERM) will
            // close it out.
            if (event.type === "assistant") {
              const blocks = extractContentBlocks(event.message);
              for (const block of blocks) {
                if (!isToolUseBlock(block)) continue;
                yield {
                  type: "tool_call_start",
                  id: block.id,
                  name: block.name,
                  input: block.input,
                  startedAt: Date.now(),
                };
              }
              continue;
            }

            // tool_result blocks ride inside the user event the CLI emits
            // after the tool executes. The content field is the model-
            // visible result; tool_use_result (top-level on the same
            // event) carries Bash-specific stdout/stderr separation —
            // we keep both, UI shows stdout primarily and surfaces
            // stderr only when non-empty.
            if (event.type === "user") {
              const blocks = extractContentBlocks(event.message);
              const tur = event.tool_use_result;
              for (const block of blocks) {
                if (!isToolResultBlock(block)) continue;
                const stdout =
                  typeof tur?.stdout === "string" ? tur.stdout : null;
                const stderr =
                  typeof tur?.stderr === "string" && tur.stderr
                    ? tur.stderr
                    : null;
                // Prefer the explicit stdout when present (Bash); fall
                // back to the block's `content` string for everything
                // else (Read/Write/Edit/WebFetch return their result
                // straight into the content field).
                const output =
                  stdout ?? (typeof block.content === "string" ? block.content : null);
                yield {
                  type: "tool_call_done",
                  id: block.tool_use_id,
                  output,
                  stderr,
                  isError: !!block.is_error,
                  endedAt: Date.now(),
                };
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

            // Surface error events. `message` is `unknown` on the line
            // type (widened to also cover assistant/user objects above)
            // so coerce safely to a string before yielding.
            if (event.type === "error" || event.type === "system_error") {
              const msg =
                typeof event.message === "string"
                  ? event.message
                  : typeof event.error === "string"
                    ? event.error
                    : "unknown error";
              yield { type: "error", message: msg };
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

// In project mode, history is already in the resumed claude session — we
// only send the current turn's question (plus an optional anchor preface).
function buildProjectPrompt(
  question: string,
  parentAnchor?: { selectedText: string } | null,
): string {
  if (parentAnchor?.selectedText) {
    return `从你上一段中我选中了「${parentAnchor.selectedText}」，继续问：${question}`;
  }
  return question;
}

type ClaudeStreamLine = Record<string, unknown> & {
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
  // `message` is overloaded: top-level string in error events, but an
  // object carrying `content: ContentBlock[]` on assistant/user events.
  // We widen to unknown and narrow inside the branches that need it.
  message?: unknown;
  error?: string;
  tool_use_result?: { stdout?: string; stderr?: string };
};

function safeParse(line: string): ClaudeStreamLine | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// Unwraps `message.content` from an assistant/user line, narrowing the
// unknown-typed payload to an array of unknown blocks. Both event
// shapes share the same wrapper — separate helpers wouldn't help.
function extractContentBlocks(message: unknown): unknown[] {
  if (!message || typeof message !== "object") return [];
  const m = message as Record<string, unknown>;
  return Array.isArray(m.content) ? (m.content as unknown[]) : [];
}

function isToolUseBlock(
  v: unknown,
): v is { type: "tool_use"; id: string; name: string; input: unknown } {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o.type === "tool_use" &&
    typeof o.id === "string" &&
    typeof o.name === "string"
  );
}

function isToolResultBlock(v: unknown): v is {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
} {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o.type === "tool_result" && typeof o.tool_use_id === "string";
}
