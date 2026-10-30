"use client";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Drawer as Vaul } from "vaul";
import { cn } from "./cn";
import { focusPanelIfIdle, portalBody, restoreFocus, trapTabKey } from "./focus";
import { LayerContainerContext } from "./Layer";
import { SheetGrabber, SHEET_EXIT_MS, SHEET_MODAL_QUERY, useMediaQuery, useSheetTouchClaim } from "./sheet";

// 弹窗原语（W2 起内部是 Radix Dialog）：portal 到 body、z-60、role=dialog、
// Tab 循环、Esc、打开自动聚焦 / 关闭归还焦点。外部 API 与旧版一致：
// 消费方条件渲染 <Modal>，关闭走 onClose。
//
// 形态：桌面（≥md）居中卡片；手机（<md）贴底 sheet（vaul，内部是同一份 Radix
// Dialog）——圆角顶 + grabber、上滑入场、跟手下拉关闭、底部让出 safe-bottom。
// size="full" 的查看器（图表 / 大图）手机上仍是全屏卡片，不做 sheet。
//
// closeOnEsc:
//   "outside-inputs"（默认）— input/textarea 聚焦时 Esc 归局部语义，不关弹窗
//   "always"            — 无条件关（搜索面板这类输入即主体的场景）
//   false               — 弹窗自管 Esc
//
// 结构与 mobile-verify 的断言对齐：[data-safe-area="modal-shell"] 是外壳，
// 其下的 [role="dialog"] 是面板。弹窗里的 Select / Tooltip / Popover 会 portal
// 进 modal-shell（LayerContainerContext），自然叠在面板上。

type ModalProps = {
  onClose: () => void;
  /** full = 铺满视口（留出外壳边距），给图表 / 大图这类查看器 */
  size?: "md" | "lg" | "full";
  closeOnEsc?: "outside-inputs" | "always" | false;
  panelClassName?: string;
  /** 读屏用的对话框名；不传则为「对话框」（面板里自己的标题仍照常显示） */
  title?: string;
  children: ReactNode;
};

export function Modal(props: ModalProps) {
  const phone = useMediaQuery(SHEET_MODAL_QUERY);
  return phone && props.size !== "full" ? <SheetModal {...props} /> : <CardModal {...props} />;
}

/** Esc 策略：input / textarea 里的 Esc 归局部语义 */
function escHandler(closeOnEsc: ModalProps["closeOnEsc"]) {
  return (e: KeyboardEvent) => {
    if (closeOnEsc === false) {
      e.preventDefault();
      return;
    }
    if (closeOnEsc === "outside-inputs") {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) e.preventDefault();
    }
  };
}

function CardModal({
  onClose,
  size = "md",
  closeOnEsc = "outside-inputs",
  panelClassName = "",
  title,
  children,
}: ModalProps) {
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
      <DialogPrimitive.Portal container={portalBody()}>
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
              data-focus-panel
              aria-describedby={undefined}
              onEscapeKeyDown={escHandler(closeOnEsc)}
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
                "w-full overflow-hidden rounded-window bg-surface-raised shadow-overlay outline-none ui-enter-layer",
                size === "full" ? "h-[calc(100%-2rem)]" : size === "lg" ? "max-w-2xl" : "max-w-xl",
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

// 手机贴底 sheet。消费方是「条件渲染 + onClose 卸载」，没有退场机会；这里自己持有
// open：请求关闭 → 先播退场（Radix Presence 等 shell 的空动画 / 面板下滑 / scrim 淡出）
// → 再调 onClose。消费方的 onClose 若没卸载（比如先弹「放弃草稿？」），重新升起来。
function SheetModal({
  onClose,
  closeOnEsc = "outside-inputs",
  panelClassName = "",
  title,
  children,
}: ModalProps) {
  const [shell, setShell] = useState<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const [opener] = useState<Element | null>(() =>
    typeof document === "undefined" ? null : document.activeElement,
  );
  const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null);
  // 内容滚到顶再下拉才拖 sheet（见 useSheetTouchClaim）
  useSheetTouchClaim(panelEl);
  const [open, setOpen] = useState(true);
  const closingRef = useRef(false);
  const mountedRef = useRef(true);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    mountedRef.current = true;
    const pending = timers.current;
    return () => {
      mountedRef.current = false;
      pending.forEach(clearTimeout);
    };
  }, []);

  const requestClose = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setOpen(false);
    timers.current.push(
      setTimeout(() => {
        onClose();
        timers.current.push(
          setTimeout(() => {
            if (!mountedRef.current) return;
            closingRef.current = false;
            setOpen(true);
          }, 50),
        );
      }, SHEET_EXIT_MS),
    );
  };

  const resetScrim = () => {
    const scrim = scrimRef.current;
    if (!scrim) return;
    scrim.style.opacity = "";
    scrim.style.transition = "";
  };

  const state = open ? "open" : "closed";
  return (
    <Vaul.Root
      open={open}
      modal={false}
      noBodyStyles
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
      onDrag={(_e, dragged) => {
        const scrim = scrimRef.current;
        if (!scrim) return;
        scrim.style.transition = "none";
        scrim.style.opacity = String(Math.max(0, 1 - dragged));
      }}
      onRelease={(_e, stayOpen) => {
        if (stayOpen) resetScrim();
      }}
    >
      <Vaul.Portal container={portalBody()}>
        <div
          ref={setShell}
          data-safe-area="modal-shell"
          data-state={state}
          className="ui-sheet-shell fixed inset-0 z-60 flex flex-col justify-end"
          style={{ paddingTop: "var(--safe-top)" }}
        >
          <div
            ref={scrimRef}
            data-state={state}
            className="ui-sheet-scrim absolute inset-0 bg-scrim/50"
            onClick={requestClose}
          />
          <LayerContainerContext.Provider value={shell}>
            <Vaul.Content
              ref={(node) => {
                panelRef.current = node;
                setPanelEl(node);
              }}
              aria-modal="true"
              data-focus-panel
              aria-describedby={undefined}
              onEscapeKeyDown={escHandler(closeOnEsc)}
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
              className="ui-sheet relative flex max-h-full w-full flex-col rounded-t-sheet border-t border-line bg-surface-raised shadow-overlay outline-none"
              style={{
                paddingBottom: "var(--safe-bottom)",
                paddingLeft: "var(--safe-left)",
                paddingRight: "var(--safe-right)",
              }}
            >
              <SheetGrabber className="h-6" />
              <Vaul.Title className="sr-only">{title ?? "对话框"}</Vaul.Title>
              <div className={cn("min-h-0 overflow-y-auto overscroll-contain", panelClassName)}>
                {children}
              </div>
            </Vaul.Content>
          </LayerContainerContext.Provider>
        </div>
      </Vaul.Portal>
    </Vaul.Root>
  );
}
