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

export const PROVIDERS: ProviderInfo[] = [
  { id: "claude-sonnet", label: "Claude Sonnet 4.6", shortLabel: "Sonnet" },
  { id: "claude-opus", label: "Claude Opus 4.7", shortLabel: "Opus" },
  { id: "claude-haiku", label: "Claude Haiku 4.5", shortLabel: "Haiku" },
  { id: "codex", label: "Codex (GPT-5)", shortLabel: "Codex" },
  { id: "mock", label: "Mock", shortLabel: "Mock", note: "调试用" },
];

export const DEFAULT_PROVIDER: ProviderId = "claude-sonnet";

export function isProviderId(s: unknown): s is ProviderId {
  return typeof s === "string" && PROVIDERS.some((p) => p.id === s);
}
