import type { ParsedCliSession } from "./cli-import";
import { parseCliSessionJsonl } from "./cli-import";
import { parseCodexSessionJsonl } from "./codex-import";

export type CliProvider = "claude" | "codex";

/** Keep sync/import callers provider-agnostic without changing Claude parsing. */
export function parseCliTranscript(
  provider: CliProvider,
  jsonlPath: string,
): ParsedCliSession | null {
  return provider === "codex"
    ? parseCodexSessionJsonl(jsonlPath)
    : parseCliSessionJsonl(jsonlPath);
}
