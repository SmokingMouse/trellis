"use client";
import { useCallback, useEffect, useState } from "react";
import { DEFAULT_PALETTE, isPaletteId, type ThemeMode } from "@/lib/themes";
import { PREF_KEYS } from "@/lib/prefs";

// Theme state = { mode, palette }:
//   mode    — light / dark / system（跟随系统），storage key 'trellis-theme'。
//             旧版本存 'light'/'dark' 二值、缺省=跟随系统——旧值天然合法，
//             缺省仍解析为 system，零迁移。
//   palette — 主题皮肤 id（lib/themes.ts 注册表），storage key
//             'trellis-palette'，default 不落 data-theme 属性。
//
// 应用机制：mode → html.dark class；palette → html[data-theme]。两者都是
// 纯 CSS 变量重绘（globals.css 的 token 层级联），不触发任何 React 重渲染
// ——所以这里刻意不用 Context，消费方只有 ThemeMenu 与 /theme 命令。
// layout.tsx 的预水合脚本镜像同样的解析逻辑，改动时保持同步。
// S89: key 名两处共用 lib/prefs.ts 的常量（layout 的脚本从同一处插值生成），
// 至少「名字」这一层不可能再漂。

const MODE_KEY = PREF_KEYS.theme;
const PALETTE_KEY = PREF_KEYS.palette;

// Module-level pub/sub so the /theme command (runs outside React) and any
// mounted ThemeMenu stay in sync without a Context.
const listeners = new Set<() => void>();
function emit() {
  listeners.forEach((fn) => fn());
}

export function getThemeMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const raw = window.localStorage.getItem(MODE_KEY);
  return raw === "light" || raw === "dark" ? raw : "system";
}

export function getThemePalette(): string {
  if (typeof window === "undefined") return DEFAULT_PALETTE;
  const raw = window.localStorage.getItem(PALETTE_KEY);
  return raw && isPaletteId(raw) ? raw : DEFAULT_PALETTE;
}

export function resolveDark(mode: ThemeMode): boolean {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return typeof window !== "undefined"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
}

export function setThemeMode(mode: ThemeMode) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolveDark(mode));
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* private mode etc — keep going */
  }
  emit();
}

export function setThemePalette(palette: string) {
  if (typeof document === "undefined" || !isPaletteId(palette)) return;
  if (palette === DEFAULT_PALETTE) {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = palette;
  }
  try {
    window.localStorage.setItem(PALETTE_KEY, palette);
  } catch {
    /* ignore */
  }
  emit();
}

export function useTheme(): {
  mode: ThemeMode | null;
  resolvedDark: boolean;
  palette: string;
  setMode: (m: ThemeMode) => void;
  setPalette: (p: string) => void;
} {
  // null until first effect so SSR html and first client render agree
  // (the pre-hydration script means the visible chrome is already correct).
  const [mode, setModeState] = useState<ThemeMode | null>(null);
  const [palette, setPaletteState] = useState(DEFAULT_PALETTE);
  const [resolvedDark, setResolvedDark] = useState(false);

  useEffect(() => {
    const sync = () => {
      setModeState(getThemeMode());
      setPaletteState(getThemePalette());
      setResolvedDark(document.documentElement.classList.contains("dark"));
    };
    sync();
    listeners.add(sync);

    // OS-level scheme changes only matter while following the system.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (getThemeMode() !== "system") return;
      document.documentElement.classList.toggle("dark", mq.matches);
      sync();
    };
    mq.addEventListener("change", onChange);
    return () => {
      listeners.delete(sync);
      mq.removeEventListener("change", onChange);
    };
  }, []);

  const setMode = useCallback((m: ThemeMode) => setThemeMode(m), []);
  const setPalette = useCallback((p: string) => setThemePalette(p), []);

  return { mode, resolvedDark, palette, setMode, setPalette };
}
