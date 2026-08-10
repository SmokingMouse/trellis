"use client";
import { useRef, useState, isValidElement, type ReactNode } from "react";
import { copyText } from "@/lib/clipboard";

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
  const [failed, setFailed] = useState(false);
  const lang = langOf(children);

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = preRef.current?.textContent ?? "";
    if (!text) return;
    try {
      await copyText(text);
      setFailed(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("[trellis] code copy failed:", err);
      setFailed(true);
      window.setTimeout(() => setFailed(false), 2000);
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
          {failed ? "✗ 失败" : copied ? "✓ 已复制" : "复制"}
        </button>
      </div>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}
