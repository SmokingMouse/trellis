"use client";
import { createElement, type ReactNode } from "react";
import { common, createLowlight } from "lowlight";

// diff / 完整文件的逐行语法高亮。复用 Markdown 代码块同一套底座：rehype-highlight
// 内部就是 lowlight(common)，token 类名 hljs-* 由 globals.css 里的 github-dark
// 样式着色（代码块恒暗是既定设计，所以审阅正文也用 --code-bg 暗底）。
//
// 逐行高亮：跨行结构（块注释、模板字符串）会在行首丢上下文，这是 diff 视图常见的
// 取舍——换来的是每行独立、可按 hunk 折叠 / 懒渲染，且长文件不需要整文件 AST。

const lowlight = createLowlight(common);

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java", kt: "kotlin",
  swift: "swift", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", sh: "bash", bash: "bash", zsh: "bash", json: "json", jsonc: "json",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", md: "markdown", markdown: "markdown",
  css: "css", scss: "scss", less: "less", html: "xml", htm: "xml", xml: "xml", svg: "xml",
  sql: "sql", lua: "lua", pl: "perl", r: "r", diff: "diff", graphql: "graphql", mk: "makefile",
};

export function languageFor(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name === "makefile") return "makefile";
  if (name === "dockerfile") return null;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  const lang = EXT_LANG[ext];
  return lang && lowlight.registered(lang) ? lang : null;
}

type HastNode =
  | { type: "text"; value: string }
  | { type: "element"; tagName: string; properties?: { className?: string[] | string }; children: HastNode[] }
  | { type: "root"; children: HastNode[] };

function toReact(node: HastNode, key: number): ReactNode {
  if (node.type === "text") return node.value;
  const children = node.children.map((c, i) => toReact(c, i));
  if (node.type === "root") return children;
  const cls = node.properties?.className;
  return createElement(node.tagName, { key, className: Array.isArray(cls) ? cls.join(" ") : cls }, ...children);
}

// 超长行（压缩产物）不高亮：既慢又没有阅读价值
const MAX_HIGHLIGHT_LINE = 1000;

export function highlightLine(text: string, lang: string | null): ReactNode {
  if (!lang || !text || text.length > MAX_HIGHLIGHT_LINE) return text;
  try {
    return toReact(lowlight.highlight(lang, text) as unknown as HastNode, 0);
  } catch {
    return text;
  }
}
