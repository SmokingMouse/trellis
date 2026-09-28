"use client";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { useRef, type ReactNode } from "react";
import { cn } from "./cn";
import { useLayerContainer } from "./Layer";

// 下拉 / 浮层原语（W2 起内部是 Radix Popover）：面板 portal 到 body（z-50），
// 不再被祖先的 stacking context 夹住——Header（fixed z-40）里的模型下拉以前
// 就是这样被右下角的树浮窗盖住的（d-14）。外部 API 不变：
//   trigger + open 受控 + onClose；trigger 自己负责 toggle（很多菜单要在点选后
//   自行决定关不关）。
//
// 点 trigger 所在的包裹层不算「外部点击」（否则 mousedown 先关、click 又开）。
// 面板不继承 trigger 附近的字号 / 颜色（portal 出去了），默认 text-ui text-ink，
// 需要别的就写在 panelClassName 里。

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
  const wrapperRef = useRef<HTMLDivElement>(null);
  const closedByEsc = useRef(false);
  const container = useLayerContainer();

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <PopoverPrimitive.Anchor asChild>
        <div ref={wrapperRef} className={cn("relative", wrapperClassName)}>
          {trigger}
        </div>
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal container={container}>
        <PopoverPrimitive.Content
          align={align}
          side="bottom"
          sideOffset={6}
          collisionPadding={8}
          onInteractOutside={(e) => {
            const t = e.target;
            if (t instanceof Node && wrapperRef.current?.contains(t)) e.preventDefault();
          }}
          onOpenAutoFocus={(e) => {
            // 不抢焦点：面板里要聚焦什么（搜索框）由消费方自己决定。
            e.preventDefault();
          }}
          onEscapeKeyDown={() => {
            closedByEsc.current = true;
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            // Esc 关掉时把焦点还给 trigger（键盘用户接着操作）；鼠标点外面关的
            // 不动焦点，免得 trigger 上无端冒出焦点环。
            const byEsc = closedByEsc.current;
            closedByEsc.current = false;
            const active = document.activeElement;
            if (byEsc && (!active || active === document.body)) {
              wrapperRef.current
                ?.querySelector<HTMLElement>("button, [href], [tabindex]:not([tabindex='-1'])")
                ?.focus({ preventScroll: true });
            }
          }}
          className={cn(
            "ui-layer z-50 overflow-hidden rounded-overlay border border-line bg-surface-raised text-ui text-ink shadow-pop outline-none",
            panelClassName,
          )}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
