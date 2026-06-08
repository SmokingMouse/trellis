import type { Components } from "react-markdown";
import { createElement } from "react";
import { CodeBlock } from "@/components/CodeBlock";

// Custom react-markdown renderers shared by ChatNode + NodeFullView so the
// markdown body looks consistent everywhere.
//
// `table` wraps the actual <table> in a horizontally-scrollable <div>:
// dense reference docs (esp. feishu wikis) often have 5+ column tables
// that bust out of a 600px canvas card. Without a wrapper, the table
// either overflows the card visually or wraps into unreadable porridge.
//
// `pre` wraps highlighted code blocks in CodeBlock, which adds a language
// label + copy button (A3/B2). `pre` only ever wraps block code, so this
// never touches inline `code`.
export const MD_COMPONENTS: Components = {
  table: ({ node, ...props }) =>
    createElement("div", { className: "md-table-wrap" }, createElement("table", props)),
  pre: ({ node, ...props }) => createElement(CodeBlock, props),
};
