// trellis Codex provider —— 薄 adapter,委托给 agent-gateway SDK 的 CodexBackend。
// login check / --ephemeral / item dedup / usage input-cached / --image / systemPrompt
// inline 全在 SDK。prompt 构造 + mode 映射留在 trellis。详见 lib/llm/sdk-adapter.ts。
import type { LLMProvider, Mode, StreamEvent, StreamRequest } from "./types";
import { buildPrompt } from "./prompt";
import { CodexBackend } from "agent-gateway";
import { modeToRunOptions, toStreamEvent, buildProjectPrompt } from "./sdk-adapter";

export function makeCodexProvider(
  opts: { mode?: Mode; model?: string } = {},
): LLMProvider {
  const mode: Mode = opts.mode ?? "chat";
  const backend = new CodexBackend();
  return {
    async *stream(req: StreamRequest): AsyncGenerator<StreamEvent> {
      const prompt =
        mode === "project"
          ? buildProjectPrompt(req.question, req.parentAnchor)
          : buildPrompt(req.history, req.question, req.parentAnchor);
      const runOpts = { ...modeToRunOptions(mode, opts.model ?? "gpt-5.5", req), signal: req.signal };
      for await (const e of backend.run(prompt, runOpts)) {
        const se = toStreamEvent(e, mode);
        if (se) yield se;
      }
    },
  };
}
