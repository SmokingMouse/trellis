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
  const mode = opts.mode ?? "lean";
  switch (id) {
    case "mock":
      return mockProvider;
    case "claude-sonnet":
      return makeClaudeProvider({ model: "sonnet", mode });
    case "claude-opus":
      return makeClaudeProvider({ model: "opus", mode });
    case "claude-haiku":
      return makeClaudeProvider({ model: "haiku", mode });
    case "codex":
      return makeCodexProvider({ mode });
  }
}
