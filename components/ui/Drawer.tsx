"use client";
import { useEffect, type ReactNode } from "react";

// 抽屉原语：桌面右侧面板 / 移动端底部 sheet，常驻挂载 + transform 过渡
// （因此天然有进/退场动画），scrim + Esc 内置。
// NotesDrawer / WorkspaceFilesDrawer 的逐行复制外壳归一到此。

export function Drawer({
  open,
  onClose,
  widthClassName = "sm:w-[360px]",
  children,
}: {
  open: boolean;
  onClose: () => void;
  widthClassName?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <div
      className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-scrim/40 sm:bg-scrim/15 transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />
      <div
        className={`absolute bg-surface shadow-overlay flex flex-col overflow-hidden transition-transform duration-200
          inset-x-0 bottom-0 h-[60vh] rounded-t-2xl
          sm:inset-x-auto sm:right-2 sm:top-14 sm:bottom-2 ${widthClassName} sm:h-auto sm:rounded-overlay
          ${
            open
              ? "translate-y-0 sm:translate-x-0"
              : "translate-y-full sm:translate-y-0 sm:translate-x-[calc(100%+0.5rem)]"
          }`}
      >
        {children}
      </div>
    </div>
  );
}
