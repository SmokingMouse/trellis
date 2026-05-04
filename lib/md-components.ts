import type { Components } from "react-markdown";
import { createElement } from "react";

// Custom react-markdown renderers shared by ChatNode + NodeFullView so the
// markdown body looks consistent everywhere.
//
// `table` wraps the actual <table> in a horizontally-scrollable <div>:
// dense reference docs (esp. feishu wikis) often have 5+ column tables
// that bust out of a 600px canvas card. Without a wrapper, the table
// either overflows the card visually or wraps into unreadable porridge.
export const MD_COMPONENTS: Components = {
  table: ({ node, ...props }) =>
    createElement("div", { className: "md-table-wrap" }, createElement("table", props)),
};
