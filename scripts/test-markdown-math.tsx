import { strict as assert } from "node:assert";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import {
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS,
} from "../lib/markdown-plugins";

const formula = String.raw`i^* = \arg\max_{i \in I} P(i | u)`;
const markdown = [
  `数学上就是求： $${formula}$`,
  "",
  `$$${formula}$$`,
  "",
  "| A | B |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "<strong>raw HTML</strong>",
  "",
  "[link](https://example.com) ![image](https://example.com/image.png)",
].join("\n");

const html = renderToStaticMarkup(
  <ReactMarkdown
    remarkPlugins={MARKDOWN_REMARK_PLUGINS}
    rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
  >
    {markdown}
  </ReactMarkdown>,
);

assert.match(html, /数学上就是求： <span class="katex">/);
assert.match(html, /<span class="katex-display">/);
assert.doesNotMatch(html, /\$\$/);
assert.match(html, /<table>/);
assert.match(html, /<code class="hljs language-ts">/);
assert.match(html, /<strong>raw HTML<\/strong>/);
assert.match(html, /<a href="https:\/\/example\.com">link<\/a>/);
assert.match(html, /<img src="https:\/\/example\.com\/image\.png" alt="image"\/>/);

console.log("markdown math + regression samples: ok");
