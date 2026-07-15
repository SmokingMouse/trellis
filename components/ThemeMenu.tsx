"use client";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { PALETTES } from "@/lib/themes";
import type { ThemeMode } from "@/lib/themes";

// Header 的主题入口：亮/暗/跟随系统 三段 + 主题皮肤 swatch 列表。
// 取代原 ThemeToggle（sun/moon 二态开关）。面板内点选不关闭——
// 方便连续试肤；outside-click / Esc 关闭。
// 注：本组件是 token utility 的首个消费方（bg-surface-raised 等），
// 也是 W4 Popover 原语的候选 pilot。

const MODE_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "系统" },
];

export function ThemeMenu() {
  const { mode, resolvedDark, palette, setMode, setPalette } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="shrink-0 p-1.5 rounded-md text-ink-muted hover:text-ink-strong hover:bg-surface-muted transition-colors"
        title="主题"
        aria-label="主题"
        aria-expanded={open}
      >
        {mode === null ? (
          <span className="block w-[16px] h-[16px]" aria-hidden />
        ) : resolvedDark ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
          </svg>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-1.5 w-52 bg-surface-raised border border-line rounded-lg shadow-pop overflow-hidden text-sm z-50">
          <div className="px-3 pt-2.5 pb-1 text-nano uppercase tracking-wide text-ink-faint">
            外观
          </div>
          <div className="px-2 pb-2 flex gap-1">
            {MODE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setMode(opt.value)}
                className={`flex-1 px-2 py-1 rounded-md text-ui transition-colors ${
                  mode === opt.value
                    ? "bg-accent-muted text-accent-ink font-medium"
                    : "text-ink-muted hover:bg-surface-muted"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="px-3 pt-1.5 pb-1 text-nano uppercase tracking-wide text-ink-faint border-t border-line-faint">
            主题
          </div>
          <div className="pb-1.5">
            {PALETTES.map((p) => (
              <button
                key={p.id}
                onClick={() => setPalette(p.id)}
                className={`w-full text-left px-3 py-1.5 flex items-center gap-2.5 transition-colors ${
                  palette === p.id ? "bg-surface-muted" : "hover:bg-surface-muted"
                }`}
              >
                <span className="flex shrink-0 rounded-full overflow-hidden border border-line w-[30px] h-[14px]">
                  {p.preview.map((c, i) => (
                    <span key={i} className="flex-1" style={{ background: c }} />
                  ))}
                </span>
                <span className="text-ui text-ink flex-1">{p.label}</span>
                {palette === p.id && (
                  <span className="text-accent text-ui" aria-hidden>
                    ✓
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
