// Client-safe barrel: types + provider metadata only.
// For getProvider() (which loads Node-only deps), import from "@/lib/llm/server".
export type {
  ChatMessage,
  Mode,
  StreamEvent,
  StreamRequest,
  LLMProvider,
  InteractionDecision,
} from "./types";
export {
  PROVIDERS,
  DEFAULT_PROVIDER,
  isProviderId,
  providerFamily,
  contextWindowFor,
  FAMILY_LABELS,
  blockedFamilySwitch,
  type ProviderId,
  type ProviderInfo,
  type ProviderFamily,
} from "./providers";
