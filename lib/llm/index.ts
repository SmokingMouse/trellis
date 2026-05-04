// Client-safe barrel: types + provider metadata only.
// For getProvider() (which loads Node-only deps), import from "@/lib/llm/server".
export type {
  ChatMessage,
  Mode,
  StreamEvent,
  StreamRequest,
  LLMProvider,
} from "./types";
export {
  PROVIDERS,
  DEFAULT_PROVIDER,
  isProviderId,
  type ProviderId,
  type ProviderInfo,
} from "./providers";
