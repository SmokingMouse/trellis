"use client";
import { useRef, useState, isValidElement, type ReactNode } from "react";

// Custom react-markdown `pre` renderer: wraps the highlighted <pre> in a
// frame with a top bar showing the language label + a copy button (A3/B2).
// Copy reads pre.textContent — robust against rehype-highlight splitting the
// source into nested <span> tokens, since textContent flattens back to source.
function langOf(children: ReactNode): string {
  if (isValidElement(children)) {
    const cn = (children.props as { className?: string }).className ?? "";
    const m = /language-([\w-]+)/.exec(cn);
    if (m) return m[1];
  }
  return "";
}

export function CodeBlock({ children }: { children?: ReactNode; node?: unknown }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const lang = langOf(children);

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = preRef.current?.textContent ?? "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (e.g. insecure context); fail silently
    }
  };

  return (
    <div className="md-codeblock">
      <div className="md-codeblock-bar" contentEditable={false}>
        <span className="md-codeblock-lang">{lang || "code"}</span>
        <button
          type="button"
          onClick={copy}
          className="md-codeblock-copy nodrag"
          aria-label="复制代码"
        >
          {copied ? "✓ 已复制" : "复制"}
        </button>
      </div>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}
