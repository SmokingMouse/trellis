"use client";
import { useEffect, type ReactNode } from "react";

// 居中弹窗原语：scrim(统一 bg-scrim/50) + 面板 + Esc + 进场动画。
// SearchModal / NewQuestionPicker / ReferencePicker / WorkspacePicker /
// CliAttachPicker / SystemPromptPicker 的手写外壳归一到此。
//
// closeOnEsc:
//   "outside-inputs"（默认）— input/textarea 聚焦时 Esc 归局部语义，不关弹窗
//   "always"            — 无条件关（搜索面板这类输入即主体的场景）
//   false               — 弹窗自管 Esc

export function Modal({
  onClose,
  size = "md",
  closeOnEsc = "outside-inputs",
  panelClassName = "",
  children,
}: {
  onClose: () => void;
  size?: "md" | "lg";
  closeOnEsc?: "outside-inputs" | "always" | false;
  panelClassName?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!closeOnEsc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (closeOnEsc === "outside-inputs") {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeOnEsc, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-scrim/50 flex items-center justify-center px-4 ui-enter-fade"
      onClick={onClose}
    >
      <div
        className={`w-full ${
          size === "lg" ? "max-w-2xl" : "max-w-xl"
        } bg-surface rounded-overlay shadow-overlay overflow-hidden border border-transparent dark:border-line ui-enter-pop ${panelClassName}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {children}
      </div>
    </div>
  );
}
