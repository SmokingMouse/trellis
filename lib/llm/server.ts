// Server-only entry point. Imports providers that depend on Node APIs
// (child_process, fs). Do not import this from a Client Component.
import "server-only";
import type { LLMProvider, Mode } from "./types";
import type { ProviderId } from "./providers";
import { mockProvider } from "./mock";
import { makeClaudeProvider } from "./claude";
import { makeCodexProvider } from "./codex";

export function getProvider(
  id: ProviderId,
  opts: { mode?: Mode } = {},
): LLMProvider {
  const mode = opts.mode ?? "chat";
  switch (id) {
    case "mock":
      return mockProvider;
    case "codex":
      return makeCodexProvider({ mode });
    default:
      // Legacy tiers ("claude-opus"/"claude-sonnet"/"claude-haiku"), bare
      // endpoints.yaml model names, and "<provider>:<model>" composite ids
      // all flow through here — resolution happens inside @sm/agent's
      // ClaudeBackend, not here (see lib/llm/sdk-adapter.ts).
      return makeClaudeProvider({ model: id, mode });
  }
}
