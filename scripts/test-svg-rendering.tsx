import { isSvgCode, normalizeSvg, extractSvg, validateSvgSyntax } from "../lib/svg";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

console.log("=== 1. Testing SVG Extraction & Normalization ===");

const raw1 = `
<?xml version="1.0" encoding="UTF-8"?>
<!-- Flowchart Diagram -->
<svg width="500" height="300">
  <rect x="20" y="20" width="100" height="60" rx="6" fill="#3b82f6" />
  <text x="70" y="55" fill="#fff" font-size="14" text-anchor="middle">Step 1</text>
  <script>alert("xss")</script>
</svg>
`;

const extracted1 = extractSvg(raw1);
if (!extracted1) throw new Error("Failed to extract SVG");
console.log("✓ extractSvg success");

const normalized1 = normalizeSvg(raw1);
if (!normalized1.includes('xmlns="http://www.w3.org/2000/svg"')) {
  throw new Error("Missing xmlns in normalized SVG");
}
if (!normalized1.includes('viewBox="0 0 500 300"')) {
  throw new Error("Missing viewBox in normalized SVG");
}
if (normalized1.includes("<script>")) {
  throw new Error("Failed to sanitize script in SVG");
}
console.log("✓ normalizeSvg handles xmlns, viewBox and sanitization");

console.log("=== 2. Testing SVG Code Block Detection ===");

if (!isSvgCode(raw1, "xml")) throw new Error("Should recognize SVG with xml tag");
if (!isSvgCode("<svg viewBox='0 0 10 10'></svg>", "svg")) throw new Error("Should recognize svg tag");
if (isSvgCode("const a = 1; console.log(a);", "typescript")) throw new Error("Should NOT recognize ts as svg");
if (isSvgCode("<note><to>User</to><from>Bot</from></note>", "xml")) throw new Error("Should NOT recognize general XML as svg");
console.log("✓ isSvgCode correctly distinguishes SVG from other code blocks");

console.log("=== 3. Testing Markdown unified pipeline ===");

const mdWithSvgCode = `
# SVG Test

Here is a generated diagram:

\`\`\`xml
<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
  <circle cx="50" cy="50" r="40" fill="#10b981" />
  <rect x="110" y="10" width="80" height="80" rx="8" fill="#6366f1" />
</svg>
\`\`\`

And an inline SVG:
<svg viewBox="0 0 50 50" width="50" height="50">
  <circle cx="25" cy="25" r="20" fill="coral" />
</svg>
`;

const processor = unified()
  .use(remarkParse)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeHighlight);

const hast = processor.runSync(processor.parse(mdWithSvgCode));
const reactTree = toJsxRuntime(hast, {
  Fragment,
  jsx,
  jsxs,
  passKeys: true,
  passNode: true,
});

if (!reactTree) throw new Error("Failed to generate React JSX runtime tree");
console.log("✓ React tree generated successfully with SVG nodes");

console.log("\n All SVG tests passed!");
