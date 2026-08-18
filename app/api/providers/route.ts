import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEndpoints, listEndpoints } from "@smokingmouse/llm";
import type { ProviderInfo } from "@/lib/llm";

// Live model catalog for the picker, sourced from endpoints.yaml (via
// @smokingmouse/llm; search order $SM_ENDPOINTS_PATH → ~/.config/sm/
// endpoints.yaml → legacy ~/.claude/global/endpoints.yaml). The file is
// OPTIONAL — a fresh deploy with just a logged-in claude CLI has none, and
// gets the native tier catalog below instead of a 500. Server-only: this is
// the one place the YAML/env-file/API keys get touched — the client only
// ever sees ids + hasKey booleans.
//
// Filtered to entries usable through the claude CLI shell (see
// @smokingmouse/agent's ClaudeBackend model resolution): a provider needs either no
// override URL at all (native claude) or an anthropic_url. openai_url-only
// providers (e.g. gemini) can't be routed through `claude --model` — the CLI
// speaks the Anthropic Messages API, not OpenAI chat-completions — so they're
// excluded here rather than surfaced as a picker option that fails at spawn
// time. (A direct, non-CLI API path for those is a possible future addition,
// not this one.)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const providers: ProviderInfo[] = yamlProviders();
  providers.push(...codexProviders());
  providers.push({
    id: "mock",
    label: "Mock",
    shortLabel: "Mock",
    note: "调试用",
    hasKey: true,
  });

  return Response.json({ providers });
}

// The CLI's native tier aliases (legacy ids, resolved to bare "opus"/
// "sonnet"/"haiku" by @smokingmouse/agent's ClaudeBackend). Served when the
// yaml can't supply a native claude entry — no yaml at all, OR a yaml whose
// providers are all third-party (typical for one created via the in-app
// model-config UI): native claude works regardless of the yaml, so it must
// never vanish from the picker.
const NATIVE_TIERS: ProviderInfo[] = [
  { id: "claude-opus", label: "Claude Opus", shortLabel: "Opus", hasKey: true },
  { id: "claude-sonnet", label: "Claude Sonnet", shortLabel: "Sonnet", hasKey: true },
  { id: "claude-haiku", label: "Claude Haiku", shortLabel: "Haiku", hasKey: true },
];

function yamlProviders(): ProviderInfo[] {
  let config: ReturnType<typeof loadEndpoints>;
  try {
    config = loadEndpoints();
  } catch {
    return [...NATIVE_TIERS];
  }
  const endpoints = listEndpoints(config).filter((e) => e.anthropic_url || !e.openai_url);
  const hasNative = endpoints.some((e) => !e.anthropic_url && !e.openai_url);
  const fromYaml = endpoints.map((e) => {
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
  return hasNative ? fromYaml : [...NATIVE_TIERS, ...fromYaml];
}

// Codex-family entries, merged from two independent sources — each becomes a
// "codex:<model>" composite id that getProvider() turns into `codex -m
// <model>`:
//   1. endpoints.yaml providers explicitly marked `codex: { wire_api:
//      responses }` — third-party Responses endpoints that CodexBackend's
//      resolveCodexModel injects via `-c model_providers.sm_endpoint.*`,
//      usable without any ChatGPT login.
//   2. ~/.codex/models_cache.json (refreshed by the codex CLI itself on
//      login/use) — the native catalog, absent on machines that never logged
//      into ChatGPT.
// On id collision the yaml entry wins, mirroring resolveCodexModel, which
// checks the yaml for an exact model hit before falling back to native
// passthrough. The bare "codex" id stays first for back-compat: existing
// sessions have model="codex" locked in the DB, and the picker's
// current-model display looks itself up by exact id.
function codexProviders(): ProviderInfo[] {
  const merged = codexYamlProviders();
  const seen = new Set(merged.map((p) => p.id));
  for (const p of codexCacheProviders()) {
    if (!seen.has(p.id)) merged.push(p);
  }
  if (merged.length === 0) {
    return [
      { id: "codex", label: "Codex (GPT-5)", shortLabel: "Codex", hasKey: true },
    ];
  }
  return [
    {
      id: "codex",
      label: "Codex（默认 gpt-5.5）",
      shortLabel: "Codex",
      hasKey: true,
    },
    ...merged,
  ];
}

// hasKey here is a plain env check on api_key_env — unlike native claude
// entries, injected codex endpoints authenticate solely via that env var
// (resolveCodexModel treats a missing key on a marked provider as fatal).
function codexYamlProviders(): ProviderInfo[] {
  let config: ReturnType<typeof loadEndpoints>;
  try {
    config = loadEndpoints();
  } catch {
    return [];
  }
  const out: ProviderInfo[] = [];
  const seen = new Set<string>();
  for (const [name, prov] of Object.entries(config.providers)) {
    if (prov.codex?.wire_api !== "responses") continue;
    const hasKey = Boolean(process.env[prov.api_key_env]);
    for (const model of prov.models) {
      const id = `codex:${model}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        label: `codex · ${name} · ${model}`,
        shortLabel: model,
        hasKey,
      });
    }
  }
  return out;
}

function codexCacheProviders(): ProviderInfo[] {
  try {
    const raw = fs.readFileSync(
      path.join(os.homedir(), ".codex", "models_cache.json"),
      "utf8",
    );
    const cache = JSON.parse(raw) as {
      models?: Array<{
        slug?: string;
        display_name?: string;
        visibility?: string;
      }>;
    };
    return (cache.models ?? [])
      .filter((m) => m.slug && m.visibility === "list")
      .map((m) => ({
        id: `codex:${m.slug}`,
        label: `codex · ${m.display_name ?? m.slug}`,
        shortLabel: m.slug!,
        hasKey: true,
      }));
  } catch {
    // No codex CLI on this machine / unreadable cache — the yaml source (and
    // the bare legacy entry) still work; spawn fails with the CLI's own error
    // if a native model is actually used.
    return [];
  }
}
