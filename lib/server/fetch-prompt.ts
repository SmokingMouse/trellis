import "server-only";

// Goal-only prompt sent to whichever CLI agent is fetching a URL on behalf
// of a reference card. We deliberately do NOT prescribe tools / skills /
// CLIs — Claude (or codex) decides on its own which path is most reliable
// for the given URL. The contract we hold them to is the output envelope
// and the "verbatim, no editorializing" hard rules.
export function buildFetchPrompt(url: string): string {
  return `You are a verbatim URL fetcher. The user added this URL as a "reference card" they want to READ — they need the original document, not your interpretation of it.

URL: ${url}

## Your job

Get the raw content at this URL and return it as Markdown wrapped in the frontmatter envelope below. You decide which tool / skill / CLI to use — pick whatever gets the original content most reliably. Tokens / OAuth for any local CLI are already configured; don't ask the user.

## Output format

EXACTLY this — no preamble, no commentary, no enclosing code fence:

\`\`\`
---
title: <document/page/video title>
platform: <feishu|youtube|bilibili|x|github|pdf|generic|...>
---

<the content as Markdown — VERBATIM from the source>
\`\`\`

If fetch fails (auth missing, doc not accessible, network error, content type unsupported):

\`\`\`
---
title: <best guess from URL>
platform: <best guess>
fetch_error: <one short Chinese sentence the user can act on>
---
\`\`\`

(no body, or partial content if any)

## Hard rules — verbatim means VERBATIM

1. **Do NOT summarize, paraphrase, or "improve" the content.** Copy it.
2. **Do NOT add section headings that aren't in the original.** No \`## Overview\`, no \`**Summary**\` block at the end.
3. **Do NOT reorder content.** Keep the original sequence of paragraphs / list items / sections.
4. **Do NOT translate.** Keep the original language.
5. **Do NOT invent content if fetch fails** — empty body is fine.
6. Minimal cleanup is OK: drop nav chrome, cookie banners, subscription gates, repeated headers/footers, image-only blocks. Keep all sentences of actual content as-is.
7. Preserve markdown structure: headings, lists, code blocks, tables, links, emphasis.
8. The output goes byte-for-byte into a reference card. No "I will now fetch..." narration. No commentary on what you did.

If your tool wraps output in YAML frontmatter, strip it before pasting into our envelope so we don't end up with nested frontmatters.`;
}

// Common shape parsed from the strict frontmatter+body envelope. Returned
// by both provider implementations so the dispatcher / API route can treat
// them uniformly.
export type ParsedFetchOutput = {
  title: string;
  platform: string;
  fetchError: string;
  body: string;
};

export function parseFetchOutput(s: string): ParsedFetchOutput | null {
  const trimmed = s.trim();
  // Allow a stray code-fence wrap if the model can't help itself.
  const stripped = trimmed
    .replace(/^```(?:markdown|md)?\n?/i, "")
    .replace(/\n?```$/i, "");
  if (!stripped.startsWith("---\n") && !stripped.startsWith("---\r\n")) {
    return null;
  }
  const headerStart = stripped.indexOf("\n") + 1;
  const closeIdx = stripped.indexOf("\n---", headerStart);
  if (closeIdx === -1) return null;
  const fm = stripped.slice(headerStart, closeIdx);
  let bodyStart = closeIdx + 4;
  if (stripped[bodyStart] === "\r") bodyStart++;
  if (stripped[bodyStart] === "\n") bodyStart++;
  const body = stripped.slice(bodyStart).trim();

  let title = "";
  let platform = "";
  let fetchError = "";
  for (const rawLine of fm.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = /^([a-z_]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^['"]|['"]$/g, "");
    if (m[1] === "title") title = value;
    else if (m[1] === "platform") platform = value;
    else if (m[1] === "fetch_error" || m[1] === "fetchError")
      fetchError = value;
  }
  return { title, platform, fetchError, body };
}
