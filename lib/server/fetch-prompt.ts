import "server-only";

// Shared instructions sent to whichever CLI agent is fetching a URL on
// behalf of a reference card. Both claude and codex consume this verbatim;
// any tool-name restrictions go in provider-specific addenda below.
const BASE = `You are a verbatim URL fetcher. The user added this URL as a "reference card" they want to READ — they need the original document, not your interpretation of it.

URL: {URL}

## Your job

1. Pick the most direct tool that returns raw content for this URL
2. Run it
3. Wrap the result in the frontmatter envelope (below)
4. Return

That's it. You are a pipe, not an editor.

## Tool selection — prefer Bash with the right CLI

\`\`\`
*.feishu.cn / *.larksuite.com / *.larkoffice.com
  → Bash: feishu-cli {doc|wiki} export <url> -o /tmp/<id>.md
    then read /tmp/<id>.md
  (DO NOT pass --front-matter; we add our own envelope)

youtube.com / youtu.be    → yt-dlp + transcript extraction, or any YouTube CLI
bilibili.com / b23.tv     → Bash: bilibili CLI of choice
x.com / twitter.com       → x-api or any reverse-engineered fetcher
*.pdf                     → pdftotext / pdfplumber / similar

generic web page          → Bash: curl -sL '<url>' | <html-to-md tool>
\`\`\`

Tokens / OAuth for these CLIs should already be configured locally — don't ask the user.

## Output format

EXACTLY this — no preamble, no commentary, no enclosing code fence:

\`\`\`
---
title: <document/page/video title>
platform: <feishu|youtube|bilibili|x|github|pdf|generic|...>
---

<the content as Markdown — VERBATIM from the tool>
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
2. **Do NOT add section headings that aren't in the original.** No \`## Overview\`, no \`## Key Information\`, no \`**Summary**\` block at the end.
3. **Do NOT reorder content.** Keep the original sequence of paragraphs / list items / sections.
4. **Do NOT translate.** Keep the original language.
5. **Do NOT invent content if fetch fails** — empty body is fine.
6. Minimal cleanup is OK: drop nav chrome, cookie banners, subscription gates, repeated headers/footers, image-only blocks. But keep all sentences of actual content as-is.
7. Preserve markdown structure: headings, lists, code blocks, tables, links, emphasis.
8. The output goes byte-for-byte into a reference card. No "I will now fetch..." narration. No commentary on what you did.

If a tool returns content already wrapped in YAML frontmatter (like feishu-cli's \`--front-matter\` flag would), strip that wrapper before pasting into our envelope so we don't end up with nested frontmatters.`;

// Claude-specific: warn off the built-in WebFetch which silently summarizes.
const CLAUDE_ADDENDUM = `

## Note for this run

AVOID the built-in \`WebFetch\` tool — it silently summarizes the page, which is exactly what we don't want. Use the \`web-fetch\` skill or raw \`curl\` instead.`;

export function buildFetchPrompt(
  url: string,
  variant: "claude" | "codex" = "claude",
): string {
  const filled = BASE.replace("{URL}", url);
  return variant === "claude" ? filled + CLAUDE_ADDENDUM : filled;
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
