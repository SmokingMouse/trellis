// Client-safe provider metadata. No Node-only imports here.
export type ProviderId =
  | "mock"
  | "claude-sonnet"
  | "claude-opus"
  | "claude-haiku"
  | "codex";

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  shortLabel: string;
  note?: string;
};

// Candidate list shown in the picker. Collapsed to three: Codex / Claude / Mock.
// "Claude" maps to opus (the single Claude tier we offer). The legacy
// claude-sonnet / claude-haiku ids stay valid in the ProviderId *type* (the
// backend still understands them) but are no longer selectable — any stored
// preference pointing at them fails isProviderId() and migrates to the
// DEFAULT_PROVIDER (opus) on next load.
export const PROVIDERS: ProviderInfo[] = [
  { id: "codex", label: "Codex (GPT-5)", shortLabel: "Codex" },
  { id: "claude-opus", label: "Claude (Opus 4.7)", shortLabel: "Claude" },
  { id: "mock", label: "Mock", shortLabel: "Mock", note: "调试用" },
];

export const DEFAULT_PROVIDER: ProviderId = "claude-opus";

export function isProviderId(s: unknown): s is ProviderId {
  return typeof s === "string" && PROVIDERS.some((p) => p.id === s);
}

// Resume ids are provider-family-scoped: a codex CLI session can only be
// resumed by codex, a claude CLI session only by claude. They must NOT be
// stored in a shared column — see the per-family resume id columns on nodes.
export type ProviderFamily = "claude" | "codex" | "mock";

export function providerFamily(id: ProviderId): ProviderFamily {
  if (id === "codex") return "codex";
  if (id === "mock") return "mock";
  return "claude"; // claude-opus / claude-sonnet / claude-haiku
}

// Per-model context window (tokens) — the denominator for the 🧠 context-
// occupancy %. The CLI's stream carries no window field (the init event has
// none), so this is a best-guess lookup keyed by the current provider. This
// setup runs Claude on the 1M tier (the opus family carries the [1m] marker),
// so opus/sonnet use 1M; haiku stays 200K. Adjust here if your tier differs —
// a wrong window only skews the % readout, nothing functional.
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
  }
}
