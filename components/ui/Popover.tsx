"use client";
import { useEffect, useRef, type ReactNode } from "react";

// 下拉/浮层原语：trigger + 面板一体（relative 包裹），outside-click 与 Esc
// 内置。ExportMenu / ModelPicker / ModePicker / ThemeMenu 的手写下拉归一到此。
//
// open 状态由消费方持有（很多菜单需要在点选后自行决定关不关）。

export function Popover({
  trigger,
  open,
  onClose,
  align = "end",
  wrapperClassName = "",
  panelClassName = "",
  children,
}: {
  trigger: ReactNode;
  open: boolean;
  onClose: () => void;
  align?: "start" | "end";
  wrapperClassName?: string;
  panelClassName?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div className={`relative ${wrapperClassName}`} ref={ref}>
      {trigger}
      {open && (
        <div
          className={`absolute ${
            align === "end" ? "right-0" : "left-0"
          } mt-1.5 bg-surface-raised border border-line rounded-lg shadow-pop overflow-hidden z-50 ui-enter-pop ${panelClassName}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
