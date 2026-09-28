"use client";
import type { ReactNode } from "react";
import { ConfirmHost } from "./ConfirmDialog";
import { TooltipProvider } from "./Tooltip";

// 根布局只挂这一个：全局单例的原语宿主（Tooltip 延迟共享 / Promise 式确认框）。
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      {children}
      <ConfirmHost />
    </TooltipProvider>
  );
}
