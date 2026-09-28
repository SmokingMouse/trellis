"use client";
import { createContext, useContext } from "react";

// 分层（z-index）约定 —— 全站只认这四档，写成 Tailwind 原生 z-* 数值类：
//   z-20  浮窗（TreePanel 这类常驻小浮层）
//   z-50  popover / 下拉菜单 / Select / Drawer
//   z-60  Modal / ConfirmDialog
//   z-70  Toast / Tooltip
//
// 弹层里再开弹层（Modal 里的 Select / Tooltip）时，外层把自己的根节点经
// LayerContainerContext 下发，内层 portal 进这个节点——落在外层的 stacking
// context 里，天然盖在外层内容之上，不用再往上加 z 值。
export const LayerContainerContext = createContext<HTMLElement | null>(null);

/** 给 Radix `Portal container` 用：外层没提供时返回 undefined（= document.body）。 */
export function useLayerContainer(): HTMLElement | undefined {
  return useContext(LayerContainerContext) ?? undefined;
}
