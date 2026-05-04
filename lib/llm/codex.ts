import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import type {
  LLMProvider,
  Mode,
  StreamEvent,
  StreamRequest,
} from "./types";
import { DEFAULT_SYSTEM_PROMPT, buildPrompt } from "./prompt";

// Default model for all modes. User confirmed gpt-5.5; override via opts.model.
const DEFAULT_MODEL = "gpt-5.5";

// Three modes mirror the claude provider:
//   lean       — folded history + system prompt prepended; --sandbox read-only
//                + --ephemeral. No tools effectively reachable.
//   cli-single — folded history; --dangerously-bypass-approvals-and-sandbox
//                + --ephemeral. Each turn stateless, history folded by trellis.
//   cli-multi  — only the current turn's question is sent; first turn spawns
//                a fresh codex session and emits session_init with the
//                thread_id; subsequent turns use `codex exec resume <id>`.
//                Persistence kept on (no --ephemeral) so resume can find the
//                rollout file under ~/.codex/sessions.
//
// codex CLI 0.125 quirks observed during integration:
//   * `--json` does NOT emit per-token deltas. agent_message arrives in one
//     `item.completed` event with the full text. We forward that as a single
//     delta — UX is "spinner, then full answer appears" rather than typewriter.
//   * `codex exec resume` rejects `--sandbox` (treated as positional). It
//     still accepts `--dangerously-bypass-approvals-and-sandbox`, `-m`,
//     `--full-auto`, `--ephemeral`, `--json`, `--skip-git-repo-check`.
//   * Don't use `--ignore-user-config` — it bypasses ChatGPT subscription
//     auth and forces codex to look up `OPENAI_API_KEY` from env, which is
//     usually wrong on a subscription account.
//   * stderr occasionally contains "failed to record rollout items: thread
//     not found" lines — non-fatal, ignore.
export function makeCodexProvider(
  opts: { mode?: Mode; model?: string } = {},
): LLMProvider {
  const mode: Mode = opts.mode ?? "lean";
  const model = opts.model ?? DEFAULT_MODEL;

  return {
    async *stream({
      history,
      question,
      parentAnchor,
      signal,
      claudeSessionId,
    }: StreamRequest): AsyncGenerator<StreamEvent> {
      // Login check up front. Cheap (sync, ~50ms) and produces a clear
      // actionable error before we waste time on an LLM round-trip that
      // would 401 anyway.
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

      const promptText =
        mode === "cli-multi"
          ? buildCliMultiPrompt(question, parentAnchor)
          : mode === "lean"
            ? prependSystemPrompt(buildPrompt(history, question, parentAnchor))
            : buildPrompt(history, question, parentAnchor);

      const args = buildArgs({
        mode,
        model,
        prompt: promptText,
        resumeId: mode === "cli-multi" ? claudeSessionId ?? null : null,
      });

      const proc = spawn("codex", args, {
        cwd: mode === "lean" ? os.tmpdir() : os.homedir(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      const onAbort = () => proc.kill("SIGTERM");
      signal?.addEventListener("abort", onAbort);

      const stderrChunks: Buffer[] = [];
      proc.stderr.on("data", (c: Buffer) => {
        if (stderrChunks.length < 64) stderrChunks.push(c);
      });

      try {
        let buffer = "";
        let yielded = false;
        let usage = { input: 0, output: 0 };
        let sessionEmitted = false;
        // Tracks already-forwarded length for the current agent_message item,
        // so re-deliveries on later events (rare but possible) don't double-emit.
        const emittedLen = new Map<string, number>();

        for await (const chunk of proc.stdout) {
          buffer += chunk.toString();
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            const event = safeParse(line);
            if (!event) continue;

            if (event.type === "thread.started") {
              if (
                !sessionEmitted &&
                typeof event.thread_id === "string"
              ) {
                yield { type: "session_init", sessionId: event.thread_id };
                sessionEmitted = true;
              }
              continue;
            }

            // agent_message text — one-shot in `item.completed`. We forward
            // the full text as a single delta. Newer codex builds may also
            // emit `item.updated` for the same item with a growing prefix;
            // dedupe by tracking emitted length per item id.
            if (
              (event.type === "item.updated" ||
                event.type === "item.completed") &&
              isAgentMessage(event.item)
            ) {
              const item = event.item as {
                id?: string;
                type: string;
                text?: string;
              };
              const id = item.id ?? "default";
              const text = item.text ?? "";
              const prevLen = emittedLen.get(id) ?? 0;
              if (text.length > prevLen) {
                yield { type: "delta", text: text.slice(prevLen) };
                emittedLen.set(id, text.length);
                yielded = true;
              }
              continue;
            }

            if (event.type === "turn.completed") {
              const u = event.usage as
                | { input_tokens?: number; output_tokens?: number }
                | undefined;
              usage = {
                input: u?.input_tokens ?? 0,
                output: u?.output_tokens ?? 0,
              };
              yield { type: "done", usage };
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
              // Many of these are transient reconnect notices that resolve
              // on their own. Only surface if we never yielded any text and
              // the stream ends — handled in the post-loop branch below.
              // For now, swallow mid-stream errors.
              const msg = (event.message as string) ?? "";
              if (!msg.toLowerCase().startsWith("reconnecting")) {
                yield { type: "error", message: msg || "codex error" };
                return;
              }
              continue;
            }

            // item.started for command_execution etc. — chat mode doesn't
            // surface these. The fetch flow has its own provider and
            // handles tool progress separately.
          }
        }

        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        if (!yielded) {
          yield {
            type: "error",
            message:
              stderr || `codex exited with code ${proc.exitCode ?? "?"}`,
          };
        } else {
          yield { type: "done", usage };
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        if (!proc.killed) proc.kill("SIGTERM");
      }
    },
  };
}

type ArgsOpts = {
  mode: Mode;
  model: string;
  prompt: string;
  resumeId: string | null;
};

function buildArgs({ mode, model, prompt, resumeId }: ArgsOpts): string[] {
  const common = [
    "--json",
    "--skip-git-repo-check",
    "-m",
    model,
  ];

  if (mode === "cli-multi" && resumeId) {
    return [
      "exec",
      "resume",
      resumeId,
      ...common,
      "--dangerously-bypass-approvals-and-sandbox",
      prompt,
    ];
  }

  // First turn (or non-multi mode).
  if (mode === "lean") {
    return [
      "exec",
      ...common,
      "--ephemeral",
      "--sandbox",
      "read-only",
      prompt,
    ];
  }

  if (mode === "cli-single") {
    return [
      "exec",
      ...common,
      "--ephemeral",
      "--dangerously-bypass-approvals-and-sandbox",
      prompt,
    ];
  }

  // cli-multi first turn — no --ephemeral so the rollout persists for resume.
  return [
    "exec",
    ...common,
    "--dangerously-bypass-approvals-and-sandbox",
    prompt,
  ];
}

function prependSystemPrompt(userPrompt: string): string {
  // codex CLI has no `--system-prompt`. We inline it as a leading instruction
  // block — the read-only sandbox prevents tool calls regardless of what the
  // model "wants" to do, so this is mostly about response style.
  return `${DEFAULT_SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`;
}

function buildCliMultiPrompt(
  question: string,
  parentAnchor?: { selectedText: string } | null,
): string {
  if (parentAnchor?.selectedText) {
    return `从你上一段中我选中了「${parentAnchor.selectedText}」，继续问：${question}`;
  }
  return question;
}

function isAgentMessage(item: unknown): boolean {
  return (
    typeof item === "object" &&
    item !== null &&
    (item as { type?: string }).type === "agent_message"
  );
}

function safeParse(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
