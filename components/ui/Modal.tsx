"use client";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useRef, useState, type ReactNode } from "react";
import { cn } from "./cn";
import { focusPanelIfIdle, restoreFocus, trapTabKey } from "./focus";
import { LayerContainerContext } from "./Layer";

// 居中弹窗原语（W2 起内部是 Radix Dialog）：portal 到 body、z-60、role=dialog、
// Tab 循环、Esc、打开自动聚焦 / 关闭归还焦点。外部 API 与旧版一致：
// 消费方条件渲染 <Modal>，关闭走 onClose。
//
// closeOnEsc:
//   "outside-inputs"（默认）— input/textarea 聚焦时 Esc 归局部语义，不关弹窗
//   "always"            — 无条件关（搜索面板这类输入即主体的场景）
//   false               — 弹窗自管 Esc
//
// 结构与 mobile-verify 的断言对齐：[data-safe-area="modal-shell"] 是 scrim 外壳，
// 其下的 [role="dialog"] 是面板。弹窗里的 Select / Tooltip / Popover 会 portal
// 进 modal-shell（LayerContainerContext），自然叠在面板上。

export function Modal({
  onClose,
  size = "md",
  closeOnEsc = "outside-inputs",
  panelClassName = "",
  title,
  children,
}: {
  onClose: () => void;
  size?: "md" | "lg";
  closeOnEsc?: "outside-inputs" | "always" | false;
  panelClassName?: string;
  /** 读屏用的对话框名；不传则为「对话框」（面板里自己的标题仍照常显示） */
  title?: string;
  children: ReactNode;
}) {
  const [shell, setShell] = useState<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [opener] = useState<Element | null>(() =>
    typeof document === "undefined" ? null : document.activeElement,
  );

  return (
    <DialogPrimitive.Root
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <div
          ref={setShell}
          data-safe-area="modal-shell"
          className="fixed inset-0 z-60 flex items-center justify-center bg-scrim/50 ui-enter-fade"
          style={{
            paddingTop: "var(--safe-top)",
            paddingBottom: "var(--safe-bottom)",
            paddingLeft: "calc(1rem + var(--safe-left))",
            paddingRight: "calc(1rem + var(--safe-right))",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <LayerContainerContext.Provider value={shell}>
            <DialogPrimitive.Content
              ref={panelRef}
              aria-modal="true"
              aria-describedby={undefined}
              onEscapeKeyDown={(e) => {
                if (closeOnEsc === false) {
                  e.preventDefault();
                  return;
                }
                if (closeOnEsc === "outside-inputs") {
                  const t = e.target as HTMLElement | null;
                  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) e.preventDefault();
                }
              }}
              // 点 scrim 由外壳 onClick 处理；其余「外部」交互（叠在上面的
              // FilePreview、旧 toast 等）一律不关弹窗。
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
                "w-full overflow-hidden rounded-overlay border border-line bg-surface shadow-overlay outline-none ui-enter-layer",
                size === "lg" ? "max-w-2xl" : "max-w-xl",
                panelClassName,
              )}
            >
              <DialogPrimitive.Title className="sr-only">{title ?? "对话框"}</DialogPrimitive.Title>
              {children}
            </DialogPrimitive.Content>
          </LayerContainerContext.Provider>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
