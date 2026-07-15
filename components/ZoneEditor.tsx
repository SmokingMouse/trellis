"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import { MD_COMPONENTS } from "@/lib/md-components";
import { Button } from "@/components/ui/Button";

// "Zone" — a full-screen, distraction-free Markdown writing surface for
// composing long-form input (esp. Feynman-mode explanations). Reusable:
// the parent owns the text via value/onChange, so closing Zone leaves the
// draft intact in the underlying input. Preview reuses the exact same
// react-markdown pipeline (.md-body + MD_COMPONENTS + same plugins) as the
// final answer render, so what you see here is what the answer body shows.
//
// Send is always ⌘↩ in Zone regardless of the global Enter/⌘Enter setting:
// in a long-form writing surface, a bare Enter must insert a newline.

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_FULL = [rehypeRaw, rehypeHighlight];

type ZoneEditorProps = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  placeholder?: string;
  submitLabel?: string;
  submitDisabled?: boolean;
  title?: string;
};

type ToolAction =
  | { kind: "wrap"; marker: string; placeholder: string }
  | { kind: "line"; prefix: string }
  | { kind: "link" };

const TOOLBAR: { label: string; title: string; action: ToolAction }[] = [
  { label: "B", title: "粗体 (⌘B)", action: { kind: "wrap", marker: "**", placeholder: "粗体" } },
  { label: "I", title: "斜体 (⌘I)", action: { kind: "wrap", marker: "*", placeholder: "斜体" } },
  { label: "`", title: "行内代码", action: { kind: "wrap", marker: "`", placeholder: "code" } },
  { label: "H", title: "标题", action: { kind: "line", prefix: "## " } },
  { label: "“", title: "引用", action: { kind: "line", prefix: "> " } },
  { label: "•", title: "无序列表", action: { kind: "line", prefix: "- " } },
  { label: "1.", title: "有序列表", action: { kind: "line", prefix: "1. " } },
  { label: "🔗", title: "链接", action: { kind: "link" } },
];

// Apply a markdown transform against the textarea's current selection.
// Returns the new value plus the [start, end] selection to restore.
function applyAction(
  value: string,
  selStart: number,
  selEnd: number,
  action: ToolAction,
): { value: string; sel: [number, number] } {
  if (action.kind === "wrap") {
    const sel = value.slice(selStart, selEnd);
    const inner = sel || action.placeholder;
    const wrapped = action.marker + inner + action.marker;
    const next = value.slice(0, selStart) + wrapped + value.slice(selEnd);
    // Select the inner text so the user can keep typing over the placeholder.
    const a = selStart + action.marker.length;
    return { value: next, sel: [a, a + inner.length] };
  }
  if (action.kind === "line") {
    const lineStart = value.lastIndexOf("\n", selStart - 1) + 1;
    const next = value.slice(0, lineStart) + action.prefix + value.slice(lineStart);
    const shift = action.prefix.length;
    return { value: next, sel: [selStart + shift, selEnd + shift] };
  }
  // link
  const sel = value.slice(selStart, selEnd);
  const text = sel || "文字";
  const snippet = `[${text}](url)`;
  const next = value.slice(0, selStart) + snippet + value.slice(selEnd);
  // Select the "url" placeholder so the user types the URL next.
  const urlStart = selStart + text.length + 3; // "[" + text + "](" === text.length + 3
  return { value: next, sel: [urlStart, urlStart + 3] };
}

export function ZoneEditor({
  value,
  onChange,
  onSubmit,
  onClose,
  placeholder,
  submitLabel = "发送",
  submitDisabled = false,
  title = "专注写作",
}: ZoneEditorProps) {
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Selection to restore after a toolbar edit flows back through value prop.
  const pendingSel = useRef<[number, number] | null>(null);

  // Focus the editor on open.
  useEffect(() => {
    if (mode === "edit") taRef.current?.focus();
  }, [mode]);

  // Restore selection after a toolbar transform re-renders with the new value.
  useEffect(() => {
    if (pendingSel.current && taRef.current) {
      const [a, b] = pendingSel.current;
      taRef.current.focus();
      taRef.current.setSelectionRange(a, b);
      pendingSel.current = null;
    }
  }, [value]);

  // Global keys: Esc closes, ⌘↩ submits — work in both edit + preview modes.
  // Capture phase + stopImmediatePropagation so Zone fully owns these keys
  // while open: otherwise other window listeners (e.g. useEscapeAbort, which
  // ignores INPUT/TEXTAREA but not the preview pane) would double-fire.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!submitDisabled) onSubmit();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose, onSubmit, submitDisabled]);

  const runAction = (action: ToolAction) => {
    const ta = taRef.current;
    if (!ta) return;
    const { value: next, sel } = applyAction(
      value,
      ta.selectionStart,
      ta.selectionEnd,
      action,
    );
    pendingSel.current = sel;
    onChange(next);
  };

  const onEditorKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      runAction({ kind: "wrap", marker: "**", placeholder: "粗体" });
    } else if ((e.metaKey || e.ctrlKey) && (e.key === "i" || e.key === "I")) {
      e.preventDefault();
      runAction({ kind: "wrap", marker: "*", placeholder: "斜体" });
    }
  };

  // Portal to <body>: Zone is a viewport-level overlay, but it's rendered
  // from inside follow-up bars that sit within transformed ancestors
  // (ReactFlow canvas, fullscreen panel). A transformed ancestor makes
  // `position: fixed` resolve against IT, not the viewport — which clipped
  // Zone to a thin strip. The portal escapes that containing block.
  return createPortal(
    <div className="fixed inset-0 z-50 bg-surface-canvas flex flex-col">
      {/* Top bar: title · edit/preview toggle · exit */}
      <div className="flex items-center justify-between px-4 sm:px-6 h-14 border-b border-line bg-surface/80 backdrop-blur">
        <div className="flex items-center gap-2 text-sm text-ink-muted min-w-0">
          <span aria-hidden>⛶</span>
          <span className="truncate">{title}</span>
        </div>
        <div className="inline-flex rounded-full border border-line bg-surface-muted p-0.5 text-ui">
          {(["edit", "preview"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`px-3 py-1 rounded-full transition-colors ${
                mode === m
                  ? "bg-surface text-ink-strong shadow-raise"
                  : "text-ink-muted hover:text-ink-strong"
              }`}
            >
              {m === "edit" ? "编辑" : "预览"}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          title="退出专注模式 (Esc)"
          className="text-sm text-ink-muted hover:text-ink-strong px-2 py-1 rounded hover:bg-surface-muted"
        >
          退出 <span className="opacity-60">Esc</span>
        </button>
      </div>

      {/* Toolbar — edit mode only */}
      {mode === "edit" && (
        <div className="flex items-center gap-1 px-4 sm:px-6 h-11 border-b border-line-faint bg-surface/40">
          <div className="max-w-3xl w-full mx-auto flex items-center gap-1">
            {TOOLBAR.map((t) => (
              <button
                key={t.title}
                type="button"
                title={t.title}
                // Keep the textarea selection intact when the button is pressed.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => runAction(t.action)}
                className="min-w-8 h-8 px-2 rounded-md text-ui text-ink-muted hover:bg-surface-muted transition-colors font-mono"
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto w-full px-5 sm:px-8 py-8">
          {mode === "edit" ? (
            <textarea
              ref={taRef}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={onEditorKey}
              placeholder={placeholder}
              className="w-full min-h-[60vh] outline-none resize-none bg-transparent text-reading leading-[1.8] text-ink-strong placeholder:text-ink-faint"
            />
          ) : value.trim() ? (
            <div className="md-body text-reading leading-[1.8]">
              <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                rehypePlugins={REHYPE_FULL}
                components={MD_COMPONENTS}
              >
                {value}
              </ReactMarkdown>
            </div>
          ) : (
            <div className="text-ink-faint text-sm">
              还没有内容——切到「编辑」开始写。
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-line bg-surface/80 backdrop-blur px-4 sm:px-6 h-14 flex items-center justify-between">
        <div className="text-xs text-ink-faint">
          ⌘↩ 发送 · Esc 退出 · 支持 Markdown
        </div>
        <Button
          type="button"
          variant="primary"
          onClick={onSubmit}
          disabled={submitDisabled}
        >
          {submitLabel}
        </Button>
      </div>
    </div>,
    document.body,
  );
}
