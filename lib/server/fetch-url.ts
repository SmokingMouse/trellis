import "server-only";
import type { ProviderId } from "@/lib/llm";
import { providerFamily } from "@/lib/llm/providers";
import type { ReferenceMeta } from "@/lib/types";
import {
  fetchUrlViaClaude,
  type FetchEvent as ClaudeFetchEvent,
} from "./fetch-via-claude";
import {
  fetchUrlViaCodex,
  type FetchEvent as CodexFetchEvent,
} from "./fetch-via-codex";

// Both fetchers emit the same FetchEvent shape — re-export from one of them.
export type FetchEvent = ClaudeFetchEvent;

// Default fetch provider when the caller doesn't specify one. Refresh
// endpoint and any other path that pre-dates the provider plumbing falls
// back to this. Keeping it as "claude-sonnet" matches existing behaviour.
const DEFAULT_FETCH_PROVIDER: ProviderId = "claude-sonnet";

// Provider-aware fetch dispatcher: routes the URL → markdown work to
// whichever local CLI agent matches the active LLM provider. The two
// implementations never depend on each other; choosing codex means the
// app no longer requires `claude` on PATH at all.
//
// Both `mock` and any unknown provider id fall back to claude — the URL
// fetcher is a separate concern from the chat LLM, and we don't have a
// "mock" implementation that would actually return content.
export async function* fetchUrlEvents(
  url: string,
  provider: ProviderId,
  signal?: AbortSignal,
): AsyncGenerator<FetchEvent> {
  // Family check, not literal equality — "codex:<model>" composite ids
  // (Session 46) must route here too, not fall through to the claude CLI.
  if (providerFamily(provider) === "codex") {
    yield* fetchUrlViaCodex(url, signal) as AsyncGenerator<CodexFetchEvent>;
    return;
  }
  yield* fetchUrlViaClaude(url, signal);
}

// Sync wrapper used by the refresh endpoint, which doesn't (yet) stream
// progress back to the client. Drains the generator and returns the
// terminal { contentMd, meta } pair.
export async function fetchByUrl(
  rawUrl: string,
  provider?: ProviderId,
  signal?: AbortSignal,
): Promise<{ contentMd: string; meta: ReferenceMeta }> {
  try {
    new URL(rawUrl);
  } catch {
    return { contentMd: "", meta: { fetchError: "URL 格式不合法" } };
  }
  const p = provider ?? DEFAULT_FETCH_PROVIDER;
  for await (const ev of fetchUrlEvents(rawUrl, p, signal)) {
    if (ev.type === "result") {
      return { contentMd: ev.contentMd, meta: ev.meta };
    }
    if (ev.type === "error") {
      return { contentMd: "", meta: { fetchError: ev.message } };
    }
  }
  return {
    contentMd: "",
    meta: { fetchError: "fetcher 没有返回任何结果" },
  };
}
