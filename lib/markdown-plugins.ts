import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Root } from "mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";

// remark-math treats `$$...$$` on one line as inline math. Trellis accepts the
// common single-line display form when it is the paragraph's only content.
const remarkSingleLineDisplayMath: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file.value);

  visit(tree, "paragraph", (paragraph) => {
    if (paragraph.children.length !== 1) return;
    const math = paragraph.children[0];
    if (math.type !== "inlineMath") return;

    const start = math.position?.start.offset;
    const end = math.position?.end.offset;
    if (start === undefined || end === undefined) return;
    const original = source.slice(start, end);
    if (!original.startsWith("$$") || !original.endsWith("$$")) return;

    math.data = {
      ...math.data,
      hProperties: {
        ...math.data?.hProperties,
        className: ["language-math", "math-display"],
      },
    };
  });
};

// Every Markdown surface shares the same syntax layer. Keep the rehype
// variants separate so streaming and hover previews retain their existing
// performance/security trade-offs while still rendering math.
export const MARKDOWN_REMARK_PLUGINS = [
  remarkGfm,
  remarkMath,
  remarkSingleLineDisplayMath,
];
export const MARKDOWN_REHYPE_PLUGINS = [
  rehypeRaw,
  rehypeKatex,
  rehypeHighlight,
];
export const MARKDOWN_STREAMING_REHYPE_PLUGINS = [rehypeKatex];
export const MARKDOWN_PREVIEW_REHYPE_PLUGINS = [rehypeKatex];
