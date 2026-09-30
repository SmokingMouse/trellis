"use client";

import { useEffect, useRef } from "react";
import { toast } from "@/components/ui";
import { isEditableTarget } from "@/lib/shortcuts";
import { nextNeedPane, stepHerdrPane } from "@/lib/herdr-console";
import { openHerdrConsolePane, useCurrentHerdrPane, useHerdrConsole } from "@/hooks/useHerdrConsole";
import { useHerdrConsoleStore } from "@/stores/herdrConsoleStore";

// Herdr 操作台快捷键。原型用 ⌘，但 ⌘1-9（标签）、⌘J（树面板过滤）、⌘K（选区分叉）、
// ⌘`（macOS 窗口循环，浏览器收不到）都已被占，这里统一换成 ⌥ 一族，按 e.code 判断
// （macOS 上 ⌥ 会把 e.key 变成 ∆ / ¡ 之类的字符）：
//   ⌥J        下一个需要你的窗格（全局）
//   ⌥K        跳到窗格面板（全局）
//   ⌥1-9      切换条第 N 个窗格（当前是 Herdr 会话时；输入框里让位，避免吞掉 ⌥3 = # 之类的字符）
//   ⌥[ / ⌥]   切换条前 / 后一个（同上）
//   ⌥`        终端抽屉（当前是 Herdr 会话时）
export function useHerdrShortcuts() {
  const hc = useHerdrConsole();
  const current = useCurrentHerdrPane(hc.panes);
  const latest = useRef({ strip: hc.strip, current });
  useEffect(() => {
    latest.current = { strip: hc.strip, current };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const { strip, current } = latest.current;
      const code = e.code;
      if (code === "KeyJ") {
        e.preventDefault();
        const next = nextNeedPane(strip, current?.key ?? null);
        if (next) openHerdrConsolePane(next);
        else toast("没有需要你处理的窗格");
        return;
      }
      if (code === "KeyK") {
        e.preventDefault();
        const store = useHerdrConsoleStore.getState();
        store.setPaletteOpen(!store.paletteOpen);
        return;
      }
      if (!current) return;
      if (code === "Backquote") {
        e.preventDefault();
        useHerdrConsoleStore.getState().toggleDrawer();
        return;
      }
      if (isEditableTarget(e.target)) return;
      const digit = /^Digit([1-9])$/.exec(code);
      if (digit) {
        const target = strip[Number(digit[1]) - 1];
        if (!target) return;
        e.preventDefault();
        if (target.key !== current.key) openHerdrConsolePane(target);
        return;
      }
      if (code === "BracketLeft" || code === "BracketRight") {
        const target = stepHerdrPane(strip, current.key, code === "BracketRight" ? 1 : -1);
        e.preventDefault();
        if (target) openHerdrConsolePane(target);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
