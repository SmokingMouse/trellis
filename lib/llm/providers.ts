// Client-safe provider metadata. No Node-only imports here.
//
// ProviderId used to be a closed union of 5 literals. It's now widened to a
// plain string: the real catalog is sourced live from ~/.claude/global/
// endpoints.yaml (via @sm/llm, server-only — see app/api/providers/route.ts)
// and can contain arbitrary "<provider>:<model>" composite ids (e.g.
// "deepseek:deepseek-v4-flash"), not just the 3 hardcoded Claude tiers. The
// legacy literals ("claude-opus"/"claude-sonnet"/"claude-haiku"/"codex"/
// "mock") remain valid values of this wider type — they still resolve
// correctly server-side (see lib/llm/server.ts, lib/llm/sdk-adapter.ts).
export type ProviderId = string;

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  shortLabel: string;
  note?: string;
  hasKey?: boolean;
};

// Static fallback shown in the picker before the live catalog (GET
// /api/providers) has loaded, and if that fetch ever fails. Not the source
// of truth — see stores/sessionStore.ts's providerCatalog.
export const PROVIDERS: ProviderInfo[] = [
  { id: "codex", label: "Codex (GPT-5)", shortLabel: "Codex" },
  { id: "claude-opus", label: "Claude (Opus 4.7)", shortLabel: "Claude" },
  { id: "mock", label: "Mock", shortLabel: "Mock", note: "调试用" },
];

export const DEFAULT_PROVIDER: ProviderId = "claude-opus";

// Structural check only (non-empty string) — the live catalog isn't
// synchronously available at this module's import time (it needs node:fs,
// and this file is explicitly client-safe/Node-free). Real validity is
// enforced server-side when the id is actually resolved to a backend (see
// ClaudeBackend's model resolution in @sm/agent) — an unknown/stale id
// surfaces as a chat error there instead of being silently rejected here.
export function isProviderId(s: unknown): s is ProviderId {
  return typeof s === "string" && s.length > 0;
}

// Resume ids are provider-family-scoped: a codex CLI session can only be
// resumed by codex, a claude CLI session only by claude. They must NOT be
// stored in a shared column — see the per-family resume id columns on nodes.
export type ProviderFamily = "claude" | "codex" | "mock";

export function providerFamily(id: ProviderId): ProviderFamily {
  if (id === "codex") return "codex";
  if (id === "mock") return "mock";
  return "claude"; // every other id (legacy tiers + endpoints.yaml ids) routes through the claude CLI shell
}

// Per-model context window (tokens) — the denominator for the 🧠 context-
// occupancy %. The CLI's stream carries no window field (the init event has
// none), so this is a best-guess lookup. endpoints.yaml has no real context-
// window data for third-party models, so unrecognized ids fall back to a
// generic guess — this is purely cosmetic (wrong window only skews the %
// readout, nothing functional).
export function contextWindowFor(id: ProviderId): number {
  switch (id) {
    case "claude-opus":
    case "claude-sonnet":
      return 1_000_000;
    case "claude-haiku":
      return 200_000;
    case "codex":
      return 400_000;
    case "mock":
      return 200_000;
    default:
      return id.includes("[1m]") ? 1_000_000 : 128_000;
  }
}
