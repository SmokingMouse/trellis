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
      // "codex:<model>" composite ids pick a specific codex model — the slug
      // after the colon goes straight to `codex -m <slug>` (CodexBackend).
      // Must be matched BEFORE the claude fallthrough: providerFamily() also
      // classifies these as codex, and handing them to ClaudeBackend would
      // cross the family boundary.
      if (id.startsWith("codex:")) {
        return makeCodexProvider({ mode, model: id.slice("codex:".length) });
      }
      // Legacy tiers ("claude-opus"/"claude-sonnet"/"claude-haiku"), bare
      // endpoints.yaml model names, and "<provider>:<model>" composite ids
      // all flow through here — resolution happens inside @sm/agent's
      // ClaudeBackend, not here (see lib/llm/sdk-adapter.ts).
      return makeClaudeProvider({ model: id, mode });
  }
}
