"use client";
import { useState } from "react";
import { Check, X } from "lucide-react";
import { copyText } from "@/lib/clipboard";
import { Icon } from "@/components/ui/Icon";

// Shared "copy to clipboard" button with a transient check-mark confirmation.
// Used for "copy whole reply" in ChatNode/NodeFullView footers. Code-block
// copy lives in CodeBlock.tsx (different layout, same clipboard pattern).
export function CopyButton({
  text,
  label = "复制",
  copiedLabel = "已复制",
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
  const [failed, setFailed] = useState(false);

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!text) return;
    try {
      await copyText(text);
      setFailed(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("[trellis] copy failed:", err);
      setFailed(true);
      window.setTimeout(() => setFailed(false), 2000);
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={title}
      aria-label="复制全文"
      className={`max-md:min-h-11 max-md:min-w-11 ${
        className ??
        "nodrag px-2 py-0.5 rounded text-ink-muted hover:bg-surface-muted hover:text-ink-strong transition-colors"
      }`}
    >
      {failed ? (
        <span className="inline-flex items-center gap-1">
          <Icon icon={X} size="sm" />
          复制失败
        </span>
      ) : copied ? (
        <span className="inline-flex items-center gap-1">
          <Icon icon={Check} size="sm" />
          {copiedLabel}
        </span>
      ) : (
        label
      )}
    </button>
  );
}
