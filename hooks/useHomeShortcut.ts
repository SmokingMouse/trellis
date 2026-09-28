"use client";
import { useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { isEditableTarget } from "@/lib/shortcuts";

// H：回首页（全局，非输入态；与 J/K/B/F/? 同一套让位规则）。登记在 lib/shortcuts.ts。
export function useHomeShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "h" && e.key !== "H") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.isComposing || isEditableTarget(e.target)) return;
      // 有弹层开着时不抢键（Modal / Drawer / 菜单里的 H 该归它们）。
      if (document.querySelector("[role='dialog'], [role='menu'], dialog[open]")) return;
      e.preventDefault();
      useSessionStore.getState().openHome();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
