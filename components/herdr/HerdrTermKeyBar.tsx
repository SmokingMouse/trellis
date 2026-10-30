// ui-guard-allow-file(hex): terminal high contrast theme（与终端抽屉同一套深色）
"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/components/ui";
import {
  AUX_KEYS,
  KEY_REPEAT_DELAY_MS,
  KEY_REPEAT_INTERVAL_MS,
  MODIFIER_KEYS,
  type AuxKey,
  type StickyModifiers,
} from "@/lib/herdr-term-keys";

// 终端辅助键栏：手机软键盘没有 Esc / Tab / Ctrl / 方向键，这一排补上。
// full = 手机（含粘滞修饰键、长按连发）；compact = 桌面（硬件键盘有修饰键，只留常用的）。
//
// 按钮用 pointerdown 触发并 preventDefault：点按钮不能把焦点从 xterm 抢走，
// 否则手机软键盘每点一下就收起一次。键盘用户（Tab 过来按 Enter/空格）走 click。

export function HerdrTermKeyBar({
  variant,
  disabled,
  modifiers,
  onToggleModifier,
  onKey,
  showModifiers = variant === "full",
}: {
  variant: "full" | "compact";
  disabled?: boolean;
  modifiers: StickyModifiers;
  onToggleModifier: (id: keyof StickyModifiers) => void;
  onKey: (key: AuxKey) => void;
  showModifiers?: boolean;
}) {
  const keys = variant === "compact" ? AUX_KEYS.filter((k) => k.compact) : AUX_KEYS;
  const repeatRef = useRef<{ delay?: ReturnType<typeof setTimeout>; tick?: ReturnType<typeof setInterval> }>({});

  const stopRepeat = () => {
    clearTimeout(repeatRef.current.delay);
    clearInterval(repeatRef.current.tick);
    repeatRef.current = {};
  };
  useEffect(() => stopRepeat, []);
  useEffect(() => {
    if (disabled) stopRepeat();
  }, [disabled]);

  const btn =
    "press shrink-0 select-none rounded-field border border-[#24283c] bg-[#141624] font-mono text-[#a0a8be] transition-colors hover:bg-[#1c2032] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40";
  const size = variant === "full" ? "h-9 min-w-9 px-2 text-xs" : "h-6.5 min-w-7 px-1.5 text-nano";

  return (
    <div
      role="toolbar"
      aria-label="终端辅助按键"
      className="flex shrink-0 items-center gap-1 overflow-x-auto overscroll-x-contain border-t border-[#1a1d2b] bg-[#08090d] px-2 py-1.5 [scrollbar-width:none]"
    >
      {showModifiers &&
        MODIFIER_KEYS.map((m) => (
          <button
            key={m.id}
            type="button"
            aria-label={m.aria}
            aria-pressed={modifiers[m.id]}
            disabled={disabled}
            onPointerDown={(e) => {
              e.preventDefault();
              onToggleModifier(m.id);
            }}
            onClick={(e) => {
              // detail === 0 = 键盘触发的 click（Enter / 空格）；指针那条路 pointerdown 已经处理过。
              if (e.detail === 0) onToggleModifier(m.id);
            }}
            className={cn(btn, size, modifiers[m.id] && "border-accent bg-accent-muted/40 text-accent-ink")}
          >
            {m.label}
          </button>
        ))}
      {showModifiers && <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-[#24283c]" />}
      {keys.map((k) => (
        <button
          key={k.id}
          type="button"
          aria-label={k.aria}
          title={k.aria}
          disabled={disabled}
          data-herdr-term-key={k.id}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            onKey(k);
            if (!k.repeat) return;
            stopRepeat();
            // 长按连发：先等 450ms 再每 60ms 一次，松手 / 滑出 / 被打断即停。
            repeatRef.current.delay = setTimeout(() => {
              repeatRef.current.tick = setInterval(() => onKey(k), KEY_REPEAT_INTERVAL_MS);
            }, KEY_REPEAT_DELAY_MS);
          }}
          onPointerUp={stopRepeat}
          onPointerLeave={stopRepeat}
          onPointerCancel={stopRepeat}
          onContextMenu={(e) => e.preventDefault()}
          onClick={(e) => {
            if (e.detail === 0) onKey(k);
          }}
          className={cn(btn, size)}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}
