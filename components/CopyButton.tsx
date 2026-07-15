"use client";
import { useState } from "react";

// Shared "copy to clipboard" button with a transient ✓ confirmation.
// Used for "copy whole reply" in ChatNode/NodeFullView footers. Code-block
// copy lives in CodeBlock.tsx (different layout, same clipboard pattern).
export function CopyButton({
  text,
  label = "复制",
  copiedLabel = "✓ 已复制",
  className,
  title = "复制全文（markdown 源）",
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
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
    <button
      type="button"
      onClick={copy}
      title={title}
      aria-label="复制全文"
      className={
        className ??
        "nodrag px-2 py-0.5 rounded text-ink-muted hover:bg-surface-muted hover:text-ink-strong transition-colors"
      }
    >
      {copied ? copiedLabel : label}
    </button>
  );
}
