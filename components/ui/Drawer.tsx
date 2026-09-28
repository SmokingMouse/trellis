"use client";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn";
import { focusPanelIfIdle, restoreFocus, trapTabKey } from "./focus";
import { LayerContainerContext } from "./Layer";

// 抽屉原语（W2 起内部是 Radix Dialog）：桌面右侧面板 / 手机底部 sheet。
// portal 到 body、z-50、role=dialog、Tab 循环、Esc、自动聚焦 / 归还焦点。
// 外部 API 不变：open 受控 + onClose。
//
// 外壳（scrim + aria-hidden）常驻挂载：mobile-verify 用
// `closest('[aria-hidden]').getAttribute('aria-hidden') === 'false'` 判断抽屉开着。
// 外壳用 react-dom 的 createPortal 自己挂，面板再用 Radix Portal 挂进外壳——
// 别给 Radix Portal 传 forceMount：Content 会继承它，关着的抽屉也常驻挂载
// （FocusScope / Esc 监听全在跑，页面加载时还会被自动聚焦）。
// 面板只在打开时挂载，进 / 退场是 data-state 驱动的 CSS 动画（globals.css
// .ui-drawer），Radix Presence 等退场动画播完再卸载。
//
// z-50 而不是 modal 的 60：FilePreview（z-60）要能从工作区文件抽屉里打开并盖在上面。

const noopSubscribe = () => () => {};

export function Drawer({
  open,
  onClose,
  widthClassName = "sm:w-[360px]",
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  widthClassName?: string;
  /** 读屏用的对话框名；不传则为「抽屉」 */
  title?: string;
  children: ReactNode;
}) {
  const [shell, setShell] = useState<HTMLDivElement | null>(null);
  // SSR 时不渲染外壳（没有 document.body）；客户端 hydrate 后再挂。
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  const panelRef = useRef<HTMLDivElement>(null);
  // 在「刚打开」的那次渲染里记下打开前的焦点（此时面板还没挂载、没抢焦点）。
  const [opener, setOpener] = useState<Element | null>(() =>
    open && typeof document !== "undefined" ? document.activeElement : null,
  );
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open && typeof document !== "undefined") setOpener(document.activeElement);
  }

  return (
    <DialogPrimitive.Root
      open={open}
      modal={false}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {hydrated &&
        createPortal(
          <div
            ref={setShell}
            className={cn("fixed inset-0 z-50", !open && "pointer-events-none")}
            aria-hidden={!open}
          >
            <div
              onClick={onClose}
              className={cn(
                "absolute inset-0 bg-scrim/40 transition-opacity duration-200 sm:bg-scrim/15",
                open ? "opacity-100" : "opacity-0",
              )}
            />
          </div>,
          document.body,
        )}
      {shell && (
        <DialogPrimitive.Portal container={shell}>
          <LayerContainerContext.Provider value={shell}>
            <DialogPrimitive.Content
              ref={panelRef}
              aria-modal="true"
              data-focus-panel
              aria-describedby={undefined}
              data-safe-area="bottom-sheet"
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
                "ui-drawer absolute inset-x-0 bottom-0 flex h-[60vh] flex-col overflow-hidden rounded-t-2xl bg-surface shadow-overlay outline-none",
                "sm:inset-x-auto sm:bottom-2 sm:right-2 sm:top-14 sm:h-auto sm:rounded-overlay sm:border sm:border-line",
                widthClassName,
              )}
              style={{
                paddingBottom: "var(--safe-bottom)",
                paddingLeft: "var(--safe-left)",
                paddingRight: "var(--safe-right)",
              }}
            >
              <DialogPrimitive.Title className="sr-only">{title ?? "抽屉"}</DialogPrimitive.Title>
              {children}
            </DialogPrimitive.Content>
          </LayerContainerContext.Provider>
        </DialogPrimitive.Portal>
      )}
    </DialogPrimitive.Root>
  );
}
