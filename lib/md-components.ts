import { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import { createElement } from "react";
import { CodeBlock } from "@/components/CodeBlock";
import { InlineFileButton, MdImage, MdLink } from "@/components/HoverPreview";
import { useSessionStore } from "@/stores/sessionStore";
import { previewablePath } from "@/lib/generated-files";

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
// react-markdown's default sanitizer drops file:// hrefs (unknown protocol) —
// but local-file links are exactly what MdLink turns into in-app previews, so
// let them through. Everything else keeps the default policy.
export const MD_URL_TRANSFORM: UrlTransform = (url) =>
  /^file:\/\//i.test(url) ? url : defaultUrlTransform(url);

export const MD_COMPONENTS: Components = {
  table: ({ node, ...props }) =>
    createElement("div", { className: "md-table-wrap" }, createElement("table", props)),
  pre: ({ node, ...props }) => createElement(CodeBlock, props),
  // `a` gets local-file smarts + hover peek (see HoverPreview.tsx).
  a: (props: any) => createElement(MdLink, props),
  // `img` routes local srcs through /api/files and degrades load failures
  // to a captioned placeholder (see HoverPreview.tsx).
  img: (props) => createElement(MdImage, props),
  // Inline `code` that names a previewable file inside the active session's
  // workspace becomes click-to-preview (opens the same global overlay as the
  // generated-files chips) with a hover peek. Block code is untouched — it
  // still flows through `pre` → CodeBlock. getState() (not a hook) reads
  // stable values; the answer re-renders on session change anyway.
  code: ({ node, className, children, ...props }: any) => {
    const text = String(children ?? "");
    const isBlock = (className ?? "").includes("language-") || text.includes("\n");
    if (isBlock) {
      return createElement("code", { className, ...props }, children);
    }
    const { session } = useSessionStore.getState();
    const abs = previewablePath(text, session?.workspacePath ?? null);
    if (!abs) {
      return createElement("code", { className, ...props }, children);
    }
    return createElement(InlineFileButton, { abs }, children);
  },
};
