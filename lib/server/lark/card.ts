/**
 * Lark Interactive Card (Schema 2.0) Builder
 *
 * Transforms standard Markdown text into Feishu Interactive Card Schema 2.0 JSON.
 * Features:
 * - Markdown dialect optimization (heading demotion, code block protection, table spacing)
 * - Strip invalid non-img_ image keys from markdown elements (CardKit 200570 protection)
 * - Section length management & code-fence safe truncation
 * - UTF-8 byte budget management (<= 24KB card JSON)
 * - Image extraction and upload via Lark image API with graceful text fallback
 * - Nonce-protected code placeholders preventing user text collision
 */

import crypto from "node:crypto";

export const CARD_MAX_BYTES = 24 * 1024; // 24KB (留 20% 余量应对飞书 30KB 硬限)
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

/**
 * BodySection (m4: 已清理无消费方的 expanded 字段，Schema 2.0 平铺渲染)
 */
export interface BodySection {
  text: string;
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
 *
 * m8: 单行内同时开闭（如 ``` inline ```）不当跨行开围栏处理。
 */
export function nextMarkdownFence(
  line: string,
  current: MarkdownFence | null,
): MarkdownFence | null {
  const trimmed = line.trim();
  if (!current) {
    const opener = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (!opener) return null;
    const marker = opener[1];
    const rest = opener[2];

    // 如果单行后续包含相同围栏符号，视为单行内闭合代码，不跨行开启围栏
    const inlineCloserPattern = new RegExp(`${marker[0]}{${marker.length},}`);
    if (inlineCloserPattern.test(rest)) {
      return null;
    }

    return {
      marker,
      opener: Buffer.byteLength(trimmed) <= 128 ? trimmed : marker,
    };
  }
  const closingPattern = new RegExp(
    `^${current.marker[0]}{${current.marker.length},}\\s*$`,
  );
  return closingPattern.test(trimmed) ? null : current;
}

/**
 * M2: 移除所有非 img_ 前缀的 ![alt](url) 引用，防止触发 CardKit error 200570。
 * 飞书卡片 markdown 元素仅认 ![desc](img_xxx)。
 */
export function stripInvalidImageKeys(text: string): string {
  if (!text.includes("![")) return text;
  return text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (fullMatch, _alt, target) => {
    const cleanTarget = target.trim().replace(/^<|>$/g, "").split(/\s+/)[0];
    if (cleanTarget.startsWith("img_")) return fullMatch;
    return "";
  });
}

/**
 * Feishu Markdown Style Optimizer
 *
 * Pre-processes standard Markdown text for optimal rendering in Feishu cards:
 * - Heading demotion: H1 → H4, H2~H6 → H5
 * - Code block protection: preserved untouched with random nonce
 * - Strip invalid image keys from markdown text (M2)
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
  // 1. M6: 提取代码块并用带有一次性随机 nonce 的占位符保护
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const MARK = `___TRELLIS_CB_${nonce}_`;
  const codeBlocks: string[] = [];
  let r = text.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g, (m) => {
    return `${MARK}${codeBlocks.push(m) - 1}___`;
  });

  // 2. m9: 标题降级检查在已剥离代码块的占位符文本上进行，避免代码块内的 # 误触
  const hasH1toH3 = /^#{1,3} /m.test(r);
  if (hasH1toH3) {
    r = r.replace(/^#{2,6} (.+)$/gm, "##### $1"); // H2~H6 → H5
    r = r.replace(/^# (.+)$/gm, "#### $1"); // H1 → H4
  }

  // 3. M2: 在占位符保护下清理残留的非 img_ 图片语法
  r = stripInvalidImageKeys(r);

  if (cardVersion >= 2) {
    // 4. Consecutive heading spacing
    r = r.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, "$1\n<br>\n$2");

    // 5. Table spacing with <br>
    r = r.replace(/^([^|\n].*)\n(\|.+\|)/gm, "$1\n\n$2");
    r = r.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, "\n\n<br>\n\n$1");
    r = r.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, "$1\n<br>\n");
    r = r.replace(/^((?!#{4,5} )(?!\*\*).+)\n\n(<br>)\n\n(\|)/gm, "$1\n$2\n$3");
    r = r.replace(/^(\*\*.+)\n\n(<br>)\n\n(\|)/gm, "$1\n$2\n\n$3");
    r = r.replace(/(\|[^\n]*\n)\n(<br>\n)((?!#{4,5} )(?!\*\*))/gm, "$1$2$3");

    // 6. Restore code blocks with <br> wrapping
    codeBlocks.forEach((block, i) => {
      r = r.replace(`${MARK}${i}___`, () => `\n<br>\n${block}\n<br>\n`);
    });
  } else {
    // 6. Restore code blocks without <br>
    codeBlocks.forEach((block, i) => {
      r = r.replace(`${MARK}${i}___`, () => block);
    });
  }

  // 7. Compress excessive blank lines (3+ → 2)
  r = r.replace(/\n{3,}/g, "\n\n");

  return r;
}

/**
 * Truncate markdown text to maxLen:
 * - m1: 严格不超出 maxLen，先预留 note 与围栏空间；maxLen 极小时降级为省略号
 * - m10: sessionUrl 为空时不输出无意义链接，只输出纯文本截断提示
 * - 保证截断后围栏闭合
 */
export function truncateMarkdown(
  text: string,
  maxLen: number = SECTION_HARD_LIMIT,
  sessionUrl?: string,
): string {
  if (text.length <= maxLen) return text;
  if (maxLen <= 0) return "";

  const cleanUrl = sessionUrl?.trim();
  const fullNote = cleanUrl
    ? `\n\n…（内容已截断，[详情见 Trellis 会话](${cleanUrl})）`
    : `\n\n…（内容已截断）`;

  // m1: 如果 maxLen 装不下完整提示语，降级为简短省略号
  let note = fullNote;
  if (maxLen < fullNote.length + 8) {
    const shortNote = "…";
    if (maxLen < shortNote.length) {
      return "";
    }
    note = `\n${shortNote}`;
    if (maxLen < note.length) {
      return shortNote;
    }
  }

  const fenceReserve = 8; // 预留闭合围栏空间（\n```）
  const available = maxLen - note.length - fenceReserve;
  if (available <= 0) {
    return note.trim().slice(0, maxLen);
  }

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

  const result = `${cut}${note}`;
  return result.length > maxLen ? result.slice(0, maxLen) : result;
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
 * m5: 与 happyclaw 一致，单段超限不在此处主动截断丢内容，由整卡字节预算统一管控。
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
    return [{ text: trimmed }];
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

  if (bins.length <= maxSections) {
    return bins.map((t) => ({ text: t }));
  }

  // 溢出时：前 maxSections - 1 个保留，其余全部合并进末尾段
  const kept = bins.slice(0, maxSections - 1);
  const tail = bins.slice(maxSections - 1).join("\n\n");
  kept.push(tail);

  return kept.map((t) => ({ text: t }));
}

function formatImageFallback(alt: string, src: string): string {
  const label = alt.trim() ? `[图片] ${alt.trim()}` : `[图片]`;
  return `${label}: ${src}`;
}

/**
 * 按照字节预算截断 Markdown 文本，并保证围栏闭合与截断提示附加
 */
function truncateContentToBytes(
  text: string,
  targetBytes: number,
  sessionUrl?: string,
): string {
  const cleanUrl = sessionUrl?.trim();
  const fullNote = cleanUrl
    ? `\n\n…（内容已截断，[详情见 Trellis 会话](${cleanUrl})）`
    : `\n\n…（内容已截断）`;

  let note = fullNote;
  let noteBytes = Buffer.byteLength(note, "utf8");
  if (targetBytes < noteBytes + 16) {
    note = "\n\n…";
    noteBytes = Buffer.byteLength(note, "utf8");
    if (targetBytes < noteBytes) {
      note = "…";
      noteBytes = Buffer.byteLength(note, "utf8");
    }
  }

  const fenceReserve = 16;
  const availableBytes = Math.max(0, targetBytes - noteBytes - fenceReserve);

  const textBuf = Buffer.from(text, "utf8");
  const cutBuf = textBuf.subarray(0, availableBytes);
  let cut = cutBuf.toString("utf8").replace(/�+$/, "");

  const lastNl = cut.lastIndexOf("\n");
  if (lastNl > cut.length * 0.7) {
    cut = cut.slice(0, lastNl);
  }

  let fence: MarkdownFence | null = null;
  for (const line of cut.split("\n")) {
    fence = nextMarkdownFence(line, fence);
  }
  if (fence) {
    cut += `\n${fence.marker}`;
  }

  return `${cut}${note}`;
}

/**
 * Build a Feishu interactive card (Schema 2.0) from markdown text.
 */
export async function buildLarkCard(
  markdown: string,
  options: LarkCardOptions = {},
): Promise<FeishuCardV2> {
  const trimmed = markdown.trim();

  // 1. M4: 计算 summary 默认值（去除 markdown 标记后的前 60 字）
  let cleanSummaryText: string | undefined;
  if (trimmed) {
    const clean = trimmed
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
      .replace(/`{1,3}[\s\S]*?`{1,3}/g, "")
      .replace(/[#*~_>]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (clean) cleanSummaryText = clean.slice(0, 60);
  }
  const summaryText = options.summary ?? cleanSummaryText;

  if (!trimmed) {
    return {
      schema: "2.0",
      config: {
        update_multi: true,
        enable_forward: true,
        width_mode: "fill",
        ...(summaryText ? { summary: { content: summaryText } } : {}),
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

  // 2. M6: 提取代码块，采用随机 nonce 占位符保护
  const cbNonce = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const CB_MARK = `___TRELLIS_CB_${cbNonce}_`;
  const codeBlocks: string[] = [];
  const textWithoutCode = markdown.replace(
    /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g,
    (match) => `${CB_MARK}${codeBlocks.push(match) - 1}___`,
  );

  // 3. 提取非代码块区域的图片
  // 匹配 ![alt](url) 或 ![alt](<url>)
  const imgRegex = /!\[([^\]]*)\]\((?:<([^>]+)>|([^)\s]+))\)/g;
  type Segment =
    | { kind: "text"; text: string }
    | { kind: "img"; alt: string; src: string };

  const segments: Segment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = imgRegex.exec(textWithoutCode)) !== null) {
    const beforeText = textWithoutCode.slice(lastIndex, match.index);
    if (beforeText) {
      segments.push({ kind: "text", text: beforeText });
    }
    const alt = match[1] || "";
    const src = match[2] || match[3] || "";
    segments.push({ kind: "img", alt, src });
    lastIndex = imgRegex.lastIndex;
  }
  const remainingText = textWithoutCode.slice(lastIndex);
  if (remainingText) {
    segments.push({ kind: "text", text: remainingText });
  }

  // 4. m7: 使用 Promise.allSettled 并发上传所有提取到的图片
  type ResolvedSegment =
    | { kind: "text"; text: string }
    | { kind: "img"; imgKey: string; alt: string };

  const imageSegments = segments.filter((s): s is Extract<Segment, { kind: "img" }> => s.kind === "img");
  const uploadResults = await Promise.allSettled(
    imageSegments.map(async (img) => {
      if (options.uploadImage) {
        return options.uploadImage(img.src);
      }
      return img.src;
    }),
  );

  let imageIdx = 0;
  const resolvedSegments: ResolvedSegment[] = [];

  for (const segment of segments) {
    if (segment.kind === "text") {
      resolvedSegments.push(segment);
    } else {
      const res = uploadResults[imageIdx++];
      const key = res.status === "fulfilled" ? res.value : "";
      if (key && key.startsWith("img_")) {
        resolvedSegments.push({
          kind: "img",
          imgKey: key,
          alt: segment.alt,
        });
      } else {
        // 上传失败或非白名单，降级为文本
        resolvedSegments.push({
          kind: "text",
          text: formatImageFallback(segment.alt, segment.src),
        });
      }
    }
  }

  // 5. 合并相邻的 text 片段
  const mergedSegments: ResolvedSegment[] = [];
  for (const seg of resolvedSegments) {
    const prev = mergedSegments[mergedSegments.length - 1];
    if (seg.kind === "text" && prev && prev.kind === "text") {
      prev.text = `${prev.text}\n\n${seg.text}`;
    } else {
      mergedSegments.push(seg);
    }
  }

  // 6. 构造卡片 body 元素
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
      // 还原代码块
      let text = seg.text;
      codeBlocks.forEach((block, i) => {
        text = text.replace(`${CB_MARK}${i}___`, () => block);
      });

      // 飞书 Markdown 方言优化
      const optimized = optimizeMarkdownStyle(text, 2);

      // 分段
      const sections = splitIntoBodySections(optimized, {
        sessionUrl: options.sessionUrl,
      });

      for (const section of sections) {
        if (section.text.trim()) {
          let sText = section.text;
          let fence: MarkdownFence | null = null;
          for (const line of sText.split("\n")) {
            fence = nextMarkdownFence(line, fence);
          }
          if (fence) {
            sText += `\n${fence.marker}`;
          }
          elements.push({
            tag: "markdown",
            content: sText,
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

  // 7. Header 处理（M4）
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

  const card: FeishuCardV2 = {
    schema: "2.0",
    config: {
      update_multi: true,
      enable_forward: true,
      width_mode: "fill",
      ...(summaryText ? { summary: { content: summaryText } } : {}),
    },
    ...(header ? { header } : {}),
    body: {
      direction: "vertical",
      vertical_spacing: "medium",
      elements,
    },
  };

  // 8. M1: 整卡 UTF-8 字节预算兜底（<= CARD_MAX_BYTES 24KB）
  const initialTotalBytes = Buffer.byteLength(JSON.stringify(card), "utf8");
  if (initialTotalBytes > CARD_MAX_BYTES) {
    // 循环弹出无法放入 24KB 的尾部元素
    while (card.body.elements.length > 1) {
      const cardWithoutLast = {
        ...card,
        body: {
          ...card.body,
          elements: card.body.elements.slice(0, -1),
        },
      };
      const bytesWithoutLast = Buffer.byteLength(JSON.stringify(cardWithoutLast), "utf8");
      if (bytesWithoutLast >= CARD_MAX_BYTES - 256) {
        card.body.elements.pop();
        continue;
      }
      const lastElem = card.body.elements[card.body.elements.length - 1];
      if (lastElem.tag === "img") {
        card.body.elements.pop();
        if (Buffer.byteLength(JSON.stringify(card), "utf8") <= CARD_MAX_BYTES) break;
        continue;
      }
      break;
    }

    // 对剩下的最后一个 markdown 元素执行精确字节截断并附带尾部链接
    const lastIdx = card.body.elements.length - 1;
    const lastElement = card.body.elements[lastIdx];
    if (lastElement && lastElement.tag === "markdown") {
      let content = String(lastElement.content ?? "");
      const cardWithoutLast = {
        ...card,
        body: {
          ...card.body,
          elements: card.body.elements.slice(0, -1),
        },
      };
      const baseBytes = Buffer.byteLength(JSON.stringify(cardWithoutLast), "utf8");
      let targetBytes = Math.max(40, CARD_MAX_BYTES - baseBytes - 120);

      lastElement.content = truncateContentToBytes(content, targetBytes, options.sessionUrl);

      while (Buffer.byteLength(JSON.stringify(card), "utf8") > CARD_MAX_BYTES && targetBytes > 30) {
        targetBytes -= 128;
        lastElement.content = truncateContentToBytes(content, targetBytes, options.sessionUrl);
      }
    }
  }

  return card;
}
