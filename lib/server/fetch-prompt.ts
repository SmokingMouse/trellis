import "server-only";

// Goal-only prompt sent to whichever CLI agent is fetching a URL on behalf
// of a reference card. We deliberately do NOT prescribe tools / skills /
// CLIs — Claude (or codex) decides on its own which path is most reliable
// for the given URL.
//
// Output contract (intentionally weak, see progress/anchor-dom-inject.md
// rationale notes): the agent returns plain Markdown, no envelope. We
// don't ask for a title field — server infers title from the body's first
// H1 (which we ask the agent to include) or from the URL. Platform is
// derived from the URL hostname server-side (more reliable than letting
// the LLM guess). The only structural signal we keep is the failure
// marker: the agent puts a `> ⚠️ ...` blockquote on the very first non-
// empty line if the fetch couldn't complete.
export function buildFetchPrompt(url: string): string {
  return `You are a verbatim URL fetcher. The user added this URL as a "reference card" they want to READ — they need the original document, not your interpretation of it.

URL: ${url}

## Your job

Get the raw content at this URL and return it as Markdown. No preamble, no commentary, no enclosing code fence — just the markdown itself.

If the page has a clear title, put it as a top-level \`# H1\` at the very top so the host app can use it as the card title.

You decide which tool / skill / CLI to use — pick whatever gets the original content most reliably. Tokens / OAuth for any local CLI are already configured; don't ask the user.

## When fetch fails

If you can't get the content (auth wall, 403/blocked, network error, content type unsupported, etc.), the FIRST non-empty line of your reply MUST be a blockquote starting with the warning emoji:

> ⚠️ <one short Chinese sentence explaining what went wrong / what the user can do>

Optional partial content or explanation can follow. The host app detects this exact prefix and surfaces a "fetch failed" state on the card.

## Hard rules — verbatim means VERBATIM

1. **Do NOT summarize, paraphrase, or "improve" the content.** Copy it.
2. **Do NOT add section headings that aren't in the original.** No \`## Overview\`, no \`**Summary**\` block at the end.
3. **Do NOT reorder content.** Keep the original sequence of paragraphs / list items / sections.
4. **Do NOT translate.** Keep the original language.
5. **Do NOT invent content if fetch fails** — empty body after the warning line is fine.
6. Minimal cleanup is OK: drop nav chrome, cookie banners, subscription gates, repeated headers/footers, image-only blocks. Keep all sentences of actual content as-is.
7. Preserve markdown structure: headings, lists, code blocks, tables, links, emphasis.
8. The output goes byte-for-byte into a reference card. No "I will now fetch..." narration. No commentary on what you did.`;
}

// Result of parsing whatever the fetcher returned. Always non-null —
// parser has fallbacks for every field. Caller doesn't need to special-
// case "format error".
export type ParsedFetchOutput = {
  contentMd: string;
  title?: string;
  platform: string;
  fetchError?: string;
};

const WARN_LINE_RE = /^>\s*⚠️\s*(.+?)\s*$/;
// Yaml-style frontmatter block: `---\n key: value\n+ ---\n`. Matches at
// the document start OR after a blank section break, so models that emit
// preamble before the envelope still get cleanly stripped. The inner
// group requires at least one `key: value` line — keeps us from
// misidentifying a markdown horizontal-rule pair (`---`) as frontmatter.
const FRONTMATTER_BLOCK_RE =
  /(^|\n)---\r?\n((?:[a-z_]+\s*:.*\r?\n)+?)---\r?\n?/i;

export function parseFetchOutput(
  rawText: string,
  url: string,
): ParsedFetchOutput {
  let body = rawText.trim();
  // Strip stray code-fence wrap if the model can't help itself.
  body = body
    .replace(/^```(?:markdown|md)?\r?\n?/i, "")
    .replace(/\r?\n?```$/i, "")
    .trim();

  // Legacy compatibility: older agents were prompted to wrap output in
  // a `--- title:... platform:... fetch_error:... ---` envelope. If the
  // body contains such a block — even with chatty preamble before it —
  // harvest the values and drop everything up to and including the
  // closing `---`. New prompts don't ask for this anymore, but sonnet
  // still emits it sometimes, and silently ignoring its title would
  // downgrade the card name to a numeric URL segment.
  let legacyTitle: string | undefined;
  let legacyFetchError: string | undefined;
  const fmMatch = FRONTMATTER_BLOCK_RE.exec(body);
  if (fmMatch) {
    for (const line of fmMatch[2].split(/\r?\n/)) {
      const km = /^([a-z_]+)\s*:\s*(.*)$/i.exec(line.trim());
      if (!km) continue;
      const value = km[2].trim().replace(/^['"]|['"]$/g, "");
      if (km[1] === "title") legacyTitle = value || undefined;
      else if (km[1] === "fetch_error" || km[1] === "fetchError")
        legacyFetchError = value || undefined;
    }
    body = body.slice(fmMatch.index + fmMatch[0].length).trim();
  }

  // Failure marker: first non-empty line is `> ⚠️ ...`. We only check the
  // first line so a user-content blockquote that happens to mention ⚠️
  // doesn't accidentally trigger the failure state.
  let fetchError = legacyFetchError;
  const firstNonEmpty = body.search(/\S/);
  if (firstNonEmpty !== -1) {
    const eol = body.indexOf("\n", firstNonEmpty);
    const firstLine = body.slice(
      firstNonEmpty,
      eol === -1 ? undefined : eol,
    );
    const m = WARN_LINE_RE.exec(firstLine.trim());
    if (m) fetchError = fetchError ?? m[1];
  }

  return {
    contentMd: body,
    title: legacyTitle ?? inferTitle(body, url),
    platform: inferPlatform(url),
    fetchError,
  };
}

// Hostname → platform tag. URL is the source of truth — more reliable
// than asking the LLM to guess. Used by ref-icon.ts to pick the card
// emoji. Add new platforms here as their fetchers stabilize.
const PLATFORM_BY_HOST: Array<[RegExp, string]> = [
  [/(^|\.)x\.com$/i, "x"],
  [/(^|\.)twitter\.com$/i, "x"],
  [/(^|\.)youtube\.com$/i, "youtube"],
  [/(^|\.)youtu\.be$/i, "youtube"],
  [/(^|\.)bilibili\.com$/i, "bilibili"],
  [/(^|\.)b23\.tv$/i, "bilibili"],
  [/(^|\.)github\.com$/i, "github"],
  [/(^|\.)feishu\.cn$/i, "feishu"],
  [/(^|\.)larksuite\.com$/i, "feishu"],
  [/(^|\.)notion\.so$/i, "notion"],
  [/(^|\.)notion\.site$/i, "notion"],
  [/(^|\.)xiaohongshu\.com$/i, "xiaohongshu"],
  [/(^|\.)zhihu\.com$/i, "zhihu"],
];

export function inferPlatform(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return "generic";
  }
  for (const [re, label] of PLATFORM_BY_HOST) {
    if (re.test(host)) return label;
  }
  if (/\.pdf(\?|#|$)/i.test(url)) return "pdf";
  return "generic";
}

// Title inference cascade: prefer the body's first `# H1` (the prompt
// asks the agent to put the page title there), then a meaningful URL
// path segment, then bare hostname. Returns undefined only when URL
// itself is unparseable — caller falls back to the source label.
export function inferTitle(body: string, url: string): string | undefined {
  const h1 = /^#\s+(.+?)\s*$/m.exec(body);
  if (h1) {
    const t = h1[1].trim();
    if (t) return t;
  }
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop();
    // All-numeric path segments (Twitter status IDs, video IDs) are
    // useless as titles — fall through to hostname instead.
    if (seg && !/^\d+$/.test(seg)) {
      return decodeURIComponent(seg).slice(0, 80);
    }
    return u.hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}
