"use client";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "./cn";
import { focusPanelIfIdle, portalBody, restoreFocus, trapTabKey } from "./focus";

// 手机贴底 action sheet（iOS 风）：上面一块圆角卡片放操作，下面单独一块「取消」。
// 给长按菜单（ContextMenu 手机形态）、回答「更多」这类「一组动作」用；要表单 / 长内容
// 用 Drawer 或 Modal。
//
// Radix Dialog modal={false}（理由同 focus.ts：不和未迁移的浮层抢指针 / 焦点），
// 点 scrim / 取消 / Esc 关。进退场是 data-state 驱动的 CSS 动画（globals.css
// .ui-action-sheet / .ui-sheet-scrim），Radix Presence 等退场播完再卸载。
//
// 分层：默认 z-50（菜单档）——从这里点开的 Modal（z-60）会盖在上面，关掉 Modal
// 回到 sheet，和原来的浮层菜单行为一致；需要盖住 Modal 的场景（弹窗里的长按菜单）
// 传 zClassName。

export function ActionSheet({
  open,
  onClose,
  title,
  label,
  cancelLabel = "取消",
  zClassName = "z-50",
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** 可见标题（灰字小标题，放在操作卡片顶部）；不传则只给读屏名 */
  title?: ReactNode;
  /** 读屏用的对话框名；不传则为「操作」 */
  label?: string;
  cancelLabel?: string;
  zClassName?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [opener, setOpener] = useState<Element | null>(null);
  const [prevOpen, setPrevOpen] = useState(false);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open && typeof document !== "undefined") setOpener(document.activeElement);
  }
  // 长按松手后浏览器可能在原地补一个 click，正好落在刚铺上的 scrim 上——刚打开的一小段时间不认 scrim 点击
  const openedAt = useRef(0);
  useEffect(() => {
    if (open) openedAt.current = Date.now();
  }, [open]);

  const state = open ? "open" : "closed";
  return (
    <DialogPrimitive.Root
      open={open}
      modal={false}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal container={portalBody()}>
        <div
          data-state={state}
          className={cn("ui-sheet-scrim fixed inset-0 bg-scrim/40", zClassName)}
          onClick={() => {
            if (Date.now() - openedAt.current < 350) return;
            onClose();
          }}
        />
        <DialogPrimitive.Content
          ref={panelRef}
          aria-modal="true"
          aria-describedby={undefined}
          data-action-sheet
          onInteractOutside={(e) => e.preventDefault()}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            focusPanelIfIdle(panelRef.current);
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            restoreFocus(opener);
          }}
          onKeyDown={trapTabKey}
          className={cn(
            "ui-action-sheet fixed inset-x-0 bottom-0 mx-auto flex w-full max-w-md flex-col gap-2 outline-none",
            zClassName,
          )}
          style={{
            maxHeight: "calc(100dvh - var(--safe-top) - 1rem)",
            paddingBottom: "calc(0.5rem + var(--safe-bottom))",
            paddingLeft: "calc(0.5rem + var(--safe-left))",
            paddingRight: "calc(0.5rem + var(--safe-right))",
          }}
        >
          <div className="min-h-0 overflow-y-auto overscroll-contain rounded-sheet bg-surface-raised shadow-overlay">
            {title ? (
              <DialogPrimitive.Title className="border-b border-line-faint px-4 py-3 text-center text-label text-ink-faint">
                {title}
              </DialogPrimitive.Title>
            ) : (
              <DialogPrimitive.Title className="sr-only">{label ?? "操作"}</DialogPrimitive.Title>
            )}
            {children}
          </div>
          <DialogPrimitive.Close
            data-action-sheet-cancel
            className="press min-h-12 shrink-0 rounded-sheet bg-surface-raised text-body font-semibold text-ink shadow-overlay active:bg-surface-hover"
          >
            {cancelLabel}
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** action sheet 里的一行操作：≥48px、整行可点；danger 红字。 */
export const actionSheetItemClass =
  "press-row flex min-h-12 w-full items-center gap-3 px-4 text-left text-body text-ink disabled:cursor-not-allowed disabled:opacity-40";
