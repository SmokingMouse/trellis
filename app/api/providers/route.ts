import "server-only";
import { loadEndpoints, listEndpoints } from "@sm/llm";
import type { ProviderInfo } from "@/lib/llm";

// Live model catalog for the picker, sourced from the same global
// ~/.claude/global/endpoints.yaml every other sm_toolkit-based project reads
// (via @sm/llm). Server-only: this is the one place the YAML/env-file/API
// keys get touched — the client only ever sees ids + hasKey booleans.
//
// Filtered to entries usable through the claude CLI shell (see
// @sm/agent's ClaudeBackend model resolution): a provider needs either no
// override URL at all (native claude) or an anthropic_url. openai_url-only
// providers (e.g. gemini) can't be routed through `claude --model` — the CLI
// speaks the Anthropic Messages API, not OpenAI chat-completions — so they're
// excluded here rather than surfaced as a picker option that fails at spawn
// time. (A direct, non-CLI API path for those is a possible future addition,
// not this one.)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const config = loadEndpoints();
  const endpoints = listEndpoints(config).filter((e) => e.anthropic_url || !e.openai_url);

  const providers: ProviderInfo[] = endpoints.map((e) => {
    // Native entries (no anthropic_url/openai_url override — currently just
    // the "claude" provider) spawn the ambient `claude` CLI unmodified, which
    // authenticates via `claude login` OAuth, not an API key env var.
    // e.hasKey (checked against api_key_env, e.g. ANTHROPIC_API_KEY) doesn't
    // apply here and would wrongly gray out every native model in the picker
    // even though it works fine — confirmed live (native claude-opus replied
    // correctly with hasKey reported false before this fix).
    const native = !e.anthropic_url && !e.openai_url;
    return {
      id: `${e.provider}:${e.model}`,
      label: e.provider === "claude" ? e.model : `${e.provider} · ${e.model}`,
      shortLabel: e.model,
      hasKey: native ? true : e.hasKey,
    };
  });

  providers.push(
    { id: "codex", label: "Codex (GPT-5)", shortLabel: "Codex", hasKey: true },
    { id: "mock", label: "Mock", shortLabel: "Mock", note: "调试用", hasKey: true },
  );

  return Response.json({ providers });
}
