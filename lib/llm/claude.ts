// trellis Claude provider —— 薄 adapter,委托给 agent-gateway SDK 的 ClaudeBackend。
// prompt 构造(buildPrompt)+ mode→RunOptions 映射留在 trellis;CLI spawn / stream-json
// 解析 / 真流式 delta / vision / tool 配对全在 SDK。详见 lib/llm/sdk-adapter.ts。
import type { LLMProvider, Mode, StreamEvent, StreamRequest } from "./types";
import { buildPrompt } from "./prompt";
import { ClaudeBackend } from "agent-gateway";
import { modeToRunOptions, toStreamEvent, buildProjectPrompt } from "./sdk-adapter";

export type ClaudeModel = "opus" | "sonnet" | "haiku";

export function makeClaudeProvider(
  opts: { model?: ClaudeModel; mode?: Mode } = {},
): LLMProvider {
  const mode: Mode = opts.mode ?? "chat";
  const backend = new ClaudeBackend();
  return {
    async *stream(req: StreamRequest): AsyncGenerator<StreamEvent> {
      const prompt =
        mode === "project"
          ? buildProjectPrompt(req.question, req.parentAnchor)
          : buildPrompt(req.history, req.question, req.parentAnchor);
      const runOpts = { ...modeToRunOptions(mode, opts.model ?? "sonnet", req), signal: req.signal };
      for await (const e of backend.run(prompt, runOpts)) {
        const se = toStreamEvent(e, mode);
        if (se) yield se;
      }
    },
  };
}
