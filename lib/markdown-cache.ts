// P0: HAST-level render cache for "done" markdown bodies.
//
// Why cache the HAST tree (not HTML strings, not React elements):
// - MD_COMPONENTS are interactive (CodeBlock copy buttons, MdLink hover
//   peeks, InlineFileButton), so a static-HTML cache would lose all of it.
// - Caching React elements wouldn't skip the pipeline either — components
//   re-execute on every mount. The expensive part is unified (parse + remark
//   + rehype-highlight + rehype-katex), which re-ran for every card on every
//   session switch because apiNodeToChatNode mints fresh node objects and
//   defeats React.memo upstream.
// - With the hast tree cached, a repeat mount only re-runs toJsxRuntime
//   (element creation, ~free).
//
// The pipeline + post-transform replicate react-markdown v10's exact render
// path (same plugins, same options, same urlTransform application). Keep them
// in sync when react-markdown is upgraded.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { visit } from "unist-util-visit";
import { VFile } from "vfile";
import { urlAttributes } from "html-url-attributes";
import type { Root as HastRoot } from "hast";
import type { ReactNode } from "react";
import {
  MARKDOWN_REMARK_PLUGINS,
  MARKDOWN_REHYPE_PLUGINS,
} from "./markdown-plugins";
import { MD_COMPONENTS, MD_URL_TRANSFORM } from "./md-components";

const processor = unified()
  .use(remarkParse)
  .use(MARKDOWN_REMARK_PLUGINS)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(MARKDOWN_REHYPE_PLUGINS)
  .freeze();

type CacheEntry = { content: string; hast: HastRoot };
// LRU: big sessions hold ~80-100 bodies; 200 entries covers a couple of
// sessions before eviction. Entries are plain trees (no DOM/React), so the
// cap is a memory bound, not a liveness one.
const cache = new Map<string, CacheEntry>();
const CAP = 200;

function getHast(cacheKey: string, content: string): HastRoot {
  const hit = cache.get(cacheKey);
  if (hit && hit.content === content) {
    cache.delete(cacheKey);
    cache.set(cacheKey, hit);
    return hit.hast;
  }
  // VFile (not a bare string) because remarkSingleLineDisplayMath reads
  // file.value to detect the $$...$$ single-line display form.
  const file = new VFile({ value: content });
  const hast = processor.runSync(processor.parse(file), file) as HastRoot;
  applyPostTransform(hast);
  if (cache.size >= CAP) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(cacheKey, { content, hast });
  return hast;
}

// react-markdown v10's post() transform, minus the allowedElements /
// disallowedElements / unwrapDisallowed branches Trellis doesn't use:
// leftover `raw` nodes become text (rehypeRaw already consumed real HTML),
// and urlTransform is applied to every URL-bearing attribute. Runs once at
// build time — the cached tree is the final, render-ready form.
function applyPostTransform(tree: HastRoot) {
  visit(tree, (node: any, index: number | null | undefined, parent: any) => {
    if (node.type === "raw" && parent && typeof index === "number") {
      parent.children[index] = { type: "text", value: node.value };
      return index;
    }
    if (node.type === "element") {
      for (const key in urlAttributes) {
        if (
          Object.hasOwn(urlAttributes, key) &&
          Object.hasOwn(node.properties, key)
        ) {
          const value = node.properties[key];
          const test = urlAttributes[key];
          if (test === null || test.includes(node.tagName)) {
            node.properties[key] = MD_URL_TRANSFORM(
              String(value || ""),
              key,
              node,
            );
          }
        }
      }
    }
  });
}

export function renderCachedMarkdown(
  cacheKey: string,
  content: string,
): ReactNode {
  return toJsxRuntime(getHast(cacheKey, content), {
    Fragment,
    components: MD_COMPONENTS,
    ignoreInvalidStyle: true,
    jsx,
    jsxs,
    passKeys: true,
    passNode: true,
  });
}

// Thin component so call sites read like the old <ReactMarkdown> usage.
export function MarkdownBody({
  cacheKey,
  content,
}: {
  cacheKey: string;
  content: string;
}) {
  return renderCachedMarkdown(cacheKey, content);
}
