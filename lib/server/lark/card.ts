/**
 * Lark Interactive Card (Schema 2.0) Builder
 *
 * Transforms standard Markdown text into Feishu Interactive Card Schema 2.0 JSON.
 * Features:
 * - Markdown dialect optimization (heading demotion, code block protection, table spacing)
 * - Section length management & code-fence safe truncation
 * - Image extraction and upload via Lark image API with graceful text fallback
 */

export const SECTION_SOFT_LIMIT = 2000;
export const SECTION_HARD_LIMIT = 4000;
export const MAX_SECTIONS = 4;
export const EMPTY_TEXT_FALLBACK = "（Agent 未返回文本）";

export type FeishuCardV2 = {
  schema: "2.0";
  config: {
    update_multi: boolean;
    enable_forward?: boolean;
    width_mode?: string;
    summary?: { content: string };
    [key: string]: unknown;
  };
  header?: {
    title: { tag: "plain_text" | "lark_md"; content: string };
    subtitle?: { tag: "plain_text"; content: string };
    template?: string;
    [key: string]: unknown;
  };
  body: {
    direction: "vertical";
    vertical_spacing: "medium" | "small" | "large";
    elements: Array<Record<string, unknown>>;
  };
};

export interface BodySection {
  text: string;
  expanded: boolean;
}

export interface LarkCardOptions {
  title?: string;
  subtitle?: string;
  template?: string;
  status?: "done" | "warning" | "error" | "running";
  sessionUrl?: string;
  summary?: string;
  uploadImage?: (src: string) => Promise<string>;
}

export interface MarkdownFence {
  marker: string;
  opener: string;
}

/**
 * Tracks markdown code fences line by line.
 * Supports both ``` and ~~~ fences of length 3+.
 */
export function nextMarkdownFence(
  line: string,
  current: MarkdownFence | null,
): MarkdownFence | null {
  const trimmed = line.trim();
  if (!current) {
    const opener = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (!opener) return null;
    return {
      marker: opener[1],
      opener: Buffer.byteLength(trimmed) <= 128 ? trimmed : opener[1],
    };
  }
  const closingPattern = new RegExp(
    `^${current.marker[0]}{${current.marker.length},}\\s*$`,
  );
  return closingPattern.test(trimmed) ? null : current;
}

/**
 * Feishu Markdown Style Optimizer
 *
 * Pre-processes standard Markdown text for optimal rendering in Feishu cards:
 * - Heading demotion: H1 → H4, H2~H6 → H5
 * - Code block protection: preserved untouched during processing
 * - Table spacing: <br> padding around tables
 * - Consecutive heading spacing: <br> between adjacent headings
 * - Blank line compression: 3+ → 2
 */
export function optimizeMarkdownStyle(text: string, cardVersion = 2): string {
  try {
    return _optimizeMarkdownStyle(text, cardVersion);
  } catch {
    return text;
  }
}

function _optimizeMarkdownStyle(text: string, cardVersion = 2): string {
  // 1. Extract code blocks and protect with placeholders
  const MARK = "___TRELLIS_CB_";
  const codeBlocks: string[] = [];
  let r = text.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g, (m) => {
    return `${MARK}${codeBlocks.push(m) - 1}___`;
  });

  // 2. Heading demotion: only demote when original text contains H1~H3
  const hasH1toH3 = /^#{1,3} /m.test(text);
  if (hasH1toH3) {
    r = r.replace(/^#{2,6} (.+)$/gm, "##### $1"); // H2~H6 → H5
    r = r.replace(/^# (.+)$/gm, "#### $1"); // H1 → H4
  }

  if (cardVersion >= 2) {
    // 3. Consecutive heading spacing
    r = r.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, "$1\n<br>\n$2");

    // 4. Table spacing with <br>
    r = r.replace(/^([^|\n].*)\n(\|.+\|)/gm, "$1\n\n$2");
    r = r.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, "\n\n<br>\n\n$1");
    r = r.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, "$1\n<br>\n");
    r = r.replace(/^((?!#{4,5} )(?!\*\*).+)\n\n(<br>)\n\n(\|)/gm, "$1\n$2\n$3");
    r = r.replace(/^(\*\*.+)\n\n(<br>)\n\n(\|)/gm, "$1\n$2\n\n$3");
    r = r.replace(/(\|[^\n]*\n)\n(<br>\n)((?!#{4,5} )(?!\*\*))/gm, "$1$2$3");

    // 5. Restore code blocks with <br> wrapping
    codeBlocks.forEach((block, i) => {
      r = r.replace(`${MARK}${i}___`, () => `\n<br>\n${block}\n<br>\n`);
    });
  } else {
    // 5. Restore code blocks without <br>
    codeBlocks.forEach((block, i) => {
      r = r.replace(`${MARK}${i}___`, () => block);
    });
  }

  // 6. Compress excessive blank lines (3+ → 2)
  r = r.replace(/\n{3,}/g, "\n\n");

  return r;
}

/**
 * Truncate markdown text to maxLen, ensuring that:
 * 1. Open code fences are cleanly closed (fences are not broken)
 * 2. Truncation note with link to Trellis session is appended
 */
export function truncateMarkdown(
  text: string,
  maxLen: number = SECTION_HARD_LIMIT,
  sessionUrl?: string,
): string {
  const url = sessionUrl || process.env.TRELLIS_PUBLIC_URL || "/";
  const note = `\n\n…（内容已截断，[详情见 Trellis 会话](${url})）`;

  if (text.length <= maxLen) return text;

  const available = maxLen - note.length;
  if (available <= 0) return note.trim();

  let cut = text.slice(0, available);
  const lastNl = cut.lastIndexOf("\n");
  if (lastNl > available * 0.7) {
    cut = cut.slice(0, lastNl);
  }

  let fence: MarkdownFence | null = null;
  const lines = cut.split("\n");
  for (const line of lines) {
    fence = nextMarkdownFence(line, fence);
  }

  if (fence) {
    cut += `\n${fence.marker}`;
  }

  return `${cut}${note}`;
}

/**
 * Split text into paragraphs without splitting inside code blocks.
 */
export function splitParagraphsSafely(text: string): string[] {
  const paragraphs: string[] = [];
  let curLines: string[] = [];
  let fence: MarkdownFence | null = null;

  const lines = text.split("\n");
  for (const line of lines) {
    fence = nextMarkdownFence(line, fence);

    if (!fence && !line.trim()) {
      if (curLines.length > 0) {
        paragraphs.push(curLines.join("\n").trim());
        curLines = [];
      }
    } else {
      curLines.push(line);
    }
  }

  if (curLines.length > 0) {
    const remaining = curLines.join("\n").trim();
    if (remaining) paragraphs.push(remaining);
  }

  return paragraphs.filter(Boolean);
}

/**
 * Split body text into <= MAX_SECTIONS sections for rendering in card markdown elements.
 */
export function splitIntoBodySections(
  text: string,
  options?: {
    sessionUrl?: string;
    softLimit?: number;
    hardLimit?: number;
    maxSections?: number;
  },
): BodySection[] {
  const softLimit = options?.softLimit ?? SECTION_SOFT_LIMIT;
  const hardLimit = options?.hardLimit ?? SECTION_HARD_LIMIT;
  const maxSections = options?.maxSections ?? MAX_SECTIONS;

  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.length <= softLimit) {
    return [{ text: trimmed, expanded: true }];
  }

  const paragraphs = splitParagraphsSafely(trimmed);

  const bins: string[] = [];
  let cur = "";
  for (const p of paragraphs) {
    if (!cur) {
      cur = p;
      continue;
    }
    const candidate = `${cur}\n\n${p}`;
    if (candidate.length > hardLimit) {
      bins.push(cur);
      cur = p;
    } else {
      cur = candidate;
    }
  }
  if (cur) bins.push(cur);

  if (bins.length === 1 && bins[0].length > hardLimit) {
    return [
      {
        text: truncateMarkdown(bins[0], hardLimit, options?.sessionUrl),
        expanded: true,
      },
    ];
  }

  if (bins.length <= maxSections) {
    return bins.map((t, i) => {
      const isLast = i === bins.length - 1;
      const sectionText =
        t.length > hardLimit
          ? truncateMarkdown(t, hardLimit, isLast ? options?.sessionUrl : undefined)
          : t;
      return { text: sectionText, expanded: i === 0 };
    });
  }

  // Overflow: keep first maxSections - 1 bins as-is, merge the rest into tail
  const kept = bins.slice(0, maxSections - 1);
  const tail = bins.slice(maxSections - 1).join("\n\n");
  const clippedTail = truncateMarkdown(tail, hardLimit, options?.sessionUrl);
  kept.push(clippedTail);

  return kept.map((t, i) => ({ text: t, expanded: i === 0 }));
}

function formatImageFallback(alt: string, src: string): string {
  const label = alt.trim() ? `[图片] ${alt.trim()}` : `[图片]`;
  return `${label}: ${src}`;
}

/**
 * Build a Feishu interactive card (Schema 2.0) from markdown text.
 */
export async function buildLarkCard(
  markdown: string,
  options: LarkCardOptions = {},
): Promise<FeishuCardV2> {
  const raw = markdown ?? "";
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      schema: "2.0",
      config: {
        update_multi: true,
        enable_forward: true,
        width_mode: "fill",
        ...(options.summary ? { summary: { content: options.summary } } : {}),
      },
      body: {
        direction: "vertical",
        vertical_spacing: "medium",
        elements: [
          {
            tag: "markdown",
            content: EMPTY_TEXT_FALLBACK,
          },
        ],
      },
    };
  }

  // 1. Close unclosed code fence if present at the end
  let normalizedMarkdown = trimmed;
  let fence: MarkdownFence | null = null;
  for (const line of normalizedMarkdown.split("\n")) {
    fence = nextMarkdownFence(line, fence);
  }
  if (fence) {
    normalizedMarkdown += `\n${fence.marker}`;
  }

  // 2. Protect code blocks from image regex and formatting
  const CB_MARK = "___TRELLIS_CB_";
  const codeBlocks: string[] = [];
  const textProtected = normalizedMarkdown.replace(
    /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g,
    (match) => {
      const idx = codeBlocks.length;
      codeBlocks.push(match);
      return `${CB_MARK}${idx}___`;
    },
  );

  // 3. Extract images outside code blocks
  type Segment =
    | { kind: "text"; text: string }
    | { kind: "image"; alt: string; src: string };

  const segments: Segment[] = [];
  let lastIndex = 0;
  const imgRegex = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = imgRegex.exec(textProtected)) !== null) {
    const textBefore = textProtected.slice(lastIndex, match.index);
    if (textBefore) {
      segments.push({ kind: "text", text: textBefore });
    }
    segments.push({ kind: "image", alt: match[1], src: match[2] });
    lastIndex = match.index + match[0].length;
  }
  const tailText = textProtected.slice(lastIndex);
  if (tailText) {
    segments.push({ kind: "text", text: tailText });
  }

  // 4. Resolve images: upload or fallback
  type ResolvedSegment =
    | { kind: "text"; text: string }
    | { kind: "img"; imgKey: string; alt: string };

  const resolvedSegments: ResolvedSegment[] = [];

  for (const segment of segments) {
    if (segment.kind === "text") {
      resolvedSegments.push(segment);
    } else {
      const src = segment.src.trim();
      if (src.startsWith("img_")) {
        resolvedSegments.push({
          kind: "img",
          imgKey: src,
          alt: segment.alt,
        });
        continue;
      }

      let uploadedKey: string | null = null;
      if (options.uploadImage) {
        try {
          uploadedKey = await options.uploadImage(src);
        } catch (uploadError) {
          console.warn(`[lark-card] 上传图片失败 (${src}):`, uploadError);
          uploadedKey = null;
        }
      }

      if (uploadedKey) {
        resolvedSegments.push({
          kind: "img",
          imgKey: uploadedKey,
          alt: segment.alt,
        });
      } else {
        resolvedSegments.push({
          kind: "text",
          text: formatImageFallback(segment.alt, src),
        });
      }
    }
  }

  // 5. Merge consecutive text segments
  const mergedSegments: ResolvedSegment[] = [];
  for (const seg of resolvedSegments) {
    const prev = mergedSegments[mergedSegments.length - 1];
    if (seg.kind === "text" && prev && prev.kind === "text") {
      prev.text = `${prev.text}\n\n${seg.text}`;
    } else {
      mergedSegments.push(seg);
    }
  }

  // 6. Build card body elements
  const elements: Array<Record<string, unknown>> = [];

  for (const seg of mergedSegments) {
    if (seg.kind === "img") {
      elements.push({
        tag: "img",
        img_key: seg.imgKey,
        alt: {
          tag: "plain_text",
          content: seg.alt || "",
        },
        mode: "fit_horizontal",
        preview: true,
      });
    } else {
      // Restore protected code blocks
      let text = seg.text;
      codeBlocks.forEach((block, i) => {
        text = text.replace(`${CB_MARK}${i}___`, () => block);
      });

      // Optimize markdown dialect for Feishu cards
      const optimized = optimizeMarkdownStyle(text, 2);

      // Split into body sections & truncate if needed
      const sections = splitIntoBodySections(optimized, {
        sessionUrl: options.sessionUrl,
      });

      for (const section of sections) {
        if (section.text.trim()) {
          elements.push({
            tag: "markdown",
            content: section.text,
          });
        }
      }
    }
  }

  if (elements.length === 0) {
    elements.push({
      tag: "markdown",
      content: EMPTY_TEXT_FALLBACK,
    });
  }

  const header = options.title
    ? {
        title: { tag: "plain_text" as const, content: options.title },
        template:
          options.template ??
          (options.status === "error"
            ? "red"
            : options.status === "warning"
              ? "orange"
              : "blue"),
        ...(options.subtitle
          ? { subtitle: { tag: "plain_text" as const, content: options.subtitle } }
          : {}),
      }
    : undefined;

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      enable_forward: true,
      width_mode: "fill",
      ...(options.summary ? { summary: { content: options.summary } } : {}),
    },
    ...(header ? { header } : {}),
    body: {
      direction: "vertical",
      vertical_spacing: "medium",
      elements,
    },
  };
}
