// trellis Codex provider —— 薄 adapter,委托给 @smokingmouse/agent(~/sdk)的 CodexBackend。
// login check / --ephemeral / item dedup / usage input-cached / --image / systemPrompt
// inline 全在 SDK。prompt 构造 + mode 映射留在 trellis。详见 lib/llm/sdk-adapter.ts。
import type { LLMProvider, Mode, StreamEvent, StreamRequest } from "./types";
import { buildPrompt } from "./prompt";
import { CodexBackend } from "@smokingmouse/agent";
import type { RunOptions } from "@smokingmouse/agent";
import { listSkills } from "@/lib/server/skills";
import {
  modeToRunOptions,
  toStreamEvent,
  buildProjectPrompt,
  ensureChatScratch,
} from "./sdk-adapter";

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
      // Enhanced chat points the workspace at the scratch dir (via
      // modeToRunOptions); make sure it exists. Pure chat skips it.
      if (mode === "chat" && req.chatEnhanced) ensureChatScratch();
      const runOpts: RunOptions = {
        ...modeToRunOptions(mode, opts.model ?? "gpt-5.5", req),
        signal: req.signal,
      };
      if (mode === "chat" && !req.chatEnhanced) {
        // Match Claude pure-chat isolation: no AGENTS.md, environment skills,
        // plugins, or MCP. Codex's built-in cached web search remains available.
        runOpts.environmentSkills = false;
        runOpts.environmentSkillNames ??= listSkills("codex").map(
          (skill) => skill.name,
        );
      } else {
        // If an Agent narrows full access to workspace-write, keep network
        // available for package managers and MCP just as normal Project mode is.
        runOpts.sandboxNetworkAccess = true;
      }
      for await (const e of backend.run(prompt, runOpts)) {
        const se = toStreamEvent(e);
        if (se) yield se;
      }
    },
  };
}
