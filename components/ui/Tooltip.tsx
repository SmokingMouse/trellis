"use client";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import { Kbd } from "./Kbd";
import { useLayerContainer } from "./Layer";

// Tooltip 原语（Radix）。根布局挂一次 <TooltipProvider>（AppProviders 里），
// 这样相邻图标之间移动时第二个 tooltip 立即出现；没挂 Provider 的渲染环境
// （单测 renderToStaticMarkup 等）自动退回局部 Provider，不会炸。
//
// 只做「给图标 / 截断文字补一句名字 + 快捷键」。不要往里放可交互内容——
// 那是 Popover。

const HasProvider = createContext(false);

export function TooltipProvider({
  children,
  delayDuration = 400,
}: {
  children: ReactNode;
  delayDuration?: number;
}) {
  return (
    <HasProvider.Provider value>
      <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={250}>
        {children}
      </TooltipPrimitive.Provider>
    </HasProvider.Provider>
  );
}

export type TooltipProps = {
  /** 提示文字；null / 空串 = 不包 tooltip，原样返回 children */
  content: ReactNode;
  /** 右侧键帽，如 "⌘K" 或 ["⌘", "K"] */
  shortcut?: string | string[];
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  delayDuration?: number;
  /** 必须是能接 ref 的单个元素（button / a / 原语） */
  children: ReactElement;
};

export function Tooltip({
  content,
  shortcut,
  side = "bottom",
  align = "center",
  delayDuration,
  children,
}: TooltipProps) {
  const hasProvider = useContext(HasProvider);
  const container = useLayerContainer();
  if (content === null || content === undefined || content === "") return children;
  const keys = shortcut === undefined ? null : Array.isArray(shortcut) ? shortcut : [shortcut];
  const tip = (
    <TooltipPrimitive.Root delayDuration={delayDuration}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal container={container}>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className="ui-layer z-70 flex max-w-72 items-center gap-2 rounded-md bg-ink-strong px-2 py-1 text-label leading-snug text-surface-canvas select-none"
        >
          <span className="min-w-0">{content}</span>
          {keys && (
            <span className="inline-flex shrink-0 gap-0.5">
              {keys.map((k, i) => (
                <Kbd
                  key={`${k}-${i}`}
                  className="border-surface-canvas/25 bg-transparent text-surface-canvas/80"
                >
                  {k}
                </Kbd>
              ))}
            </span>
          )}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
  return hasProvider ? tip : <TooltipPrimitive.Provider>{tip}</TooltipPrimitive.Provider>;
}
