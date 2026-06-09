import type { Components } from "react-markdown";
import { createElement, type MouseEvent } from "react";
import { CodeBlock } from "@/components/CodeBlock";
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
export const MD_COMPONENTS: Components = {
  table: ({ node, ...props }) =>
    createElement("div", { className: "md-table-wrap" }, createElement("table", props)),
  pre: ({ node, ...props }) => createElement(CodeBlock, props),
  // Inline `code` that names a previewable file inside the active session's
  // workspace becomes click-to-preview (opens the same global overlay as the
  // generated-files chips). Block code is untouched — it still flows through
  // `pre` → CodeBlock. getState() (not a hook) reads stable values; the answer
  // re-renders on session change anyway.
  code: ({ node, className, children, ...props }: any) => {
    const text = String(children ?? "");
    const isBlock = (className ?? "").includes("language-") || text.includes("\n");
    if (isBlock) {
      return createElement("code", { className, ...props }, children);
    }
    const { session, openFilePreview } = useSessionStore.getState();
    const abs = previewablePath(text, session?.workspacePath ?? null);
    if (!abs) {
      return createElement("code", { className, ...props }, children);
    }
    return createElement(
      "button",
      {
        type: "button",
        title: "点击预览",
        onClick: (e: MouseEvent) => {
          e.stopPropagation();
          openFilePreview(abs);
        },
        className:
          "nodrag px-1 py-0.5 mx-0.5 rounded bg-indigo-50 dark:bg-indigo-950/50 text-[0.9em] font-mono text-indigo-600 dark:text-indigo-300 underline decoration-dotted decoration-indigo-300 dark:decoration-indigo-700 underline-offset-2 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 cursor-pointer align-baseline",
      },
      children,
    );
  },
};
