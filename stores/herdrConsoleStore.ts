"use client";
import { create } from "zustand";

// Herdr 操作台的临时 UI 态：终端抽屉、切换条闪烁、跨窗格通知、跳转面板。
// 刻意不进 sessionStore（它只知道 herdrOpen 一个字段 —— 总览是否是当前视图），
// 这里的状态全是一次性的，不落 localStorage。

export type HerdrNotice = {
  key: string;
  paneId: string;
  where: string;
  text: string;
  at: number;
};

type State = {
  /** 终端抽屉是否打开 */
  drawerOpen: boolean;
  /** 抽屉目标：null = 当前会话的窗格；纯 shell / 无绑定窗格从总览打开时显式指定 */
  drawerPaneId: string | null;
  /** 切换条 chip 闪烁：paneKey → 触发时刻 */
  flash: Record<string, number>;
  notice: HerdrNotice | null;
  paletteOpen: boolean;
  /** 移动端 Fleet 态势切换抽屉是否打开 */
  fleetPickerOpen: boolean;
};

type Actions = {
  openDrawer: (paneId?: string | null) => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;
  raise: (notice: HerdrNotice) => void;
  dismissNotice: () => void;
  clearFlash: (key: string) => void;
  setPaletteOpen: (open: boolean) => void;
  setFleetPickerOpen: (open: boolean) => void;
  toggleFleetPicker: () => void;
};

export const useHerdrConsoleStore = create<State & Actions>((set, get) => ({
  drawerOpen: false,
  drawerPaneId: null,
  flash: {},
  notice: null,
  paletteOpen: false,
  fleetPickerOpen: false,
  openDrawer: (paneId = null) => set({ drawerOpen: true, drawerPaneId: paneId }),
  closeDrawer: () => set({ drawerOpen: false, drawerPaneId: null }),
  toggleDrawer: () => (get().drawerOpen ? get().closeDrawer() : get().openDrawer(null)),
  raise: (notice) => set((s) => ({ notice, flash: { ...s.flash, [notice.key]: notice.at } })),
  dismissNotice: () => set({ notice: null }),
  clearFlash: (key) =>
    set((s) => {
      if (!(key in s.flash)) return s;
      const flash = { ...s.flash };
      delete flash[key];
      return { flash };
    }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setFleetPickerOpen: (fleetPickerOpen) => set({ fleetPickerOpen }),
  toggleFleetPicker: () => set((s) => ({ fleetPickerOpen: !s.fleetPickerOpen })),
}));
