"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Icon, cn } from "@/components/ui";
import { overflowX, usePrefersReducedMotion, useSwipe } from "@/hooks/useSwipe";
import { startsInHorizontalScroller } from "@/lib/gestures";
import {
  ROW_ACTION_WIDTH,
  dragOffset,
  isFullArmed,
  resolveRowSwipe,
  restOffset,
  type RowSwipeConfig,
  type RowSwipeSide,
} from "@/lib/row-swipe";

// 列表行左右滑动（iOS 邮件 / Codex 手机端侧栏同款），判定在 lib/row-swipe.ts：
//   左滑 → 右侧露出 trailing 按钮；右滑 → 左侧露出 leading 按钮；
//   划过「整行阈值」松手 → 直接执行该侧第一个动作（fullSwipe=true 的那个，危险动作别放这里）；
//   松在半途 → 停在展开态，按钮 72px 宽、行高 44px，可以直接点。
// 手势用 hooks/useSwipe（Pointer Events，只认 touch；锁轴纵向优先，锁到纵向就放手给列表滚动）。
// 同时只允许一行展开：展开状态由父级持有（open / onOpenChange）；点行外任意处收回，
// 点展开着的行本身也只收回、不触发行的单击。
//
// trailing 数组按「从内到外」排：最后一个贴着行的右边缘，划到底执行的是它。

export type SwipeRowAction = {
  key: string;
  label: string;
  icon: LucideIcon;
  tone: "accent" | "danger" | "warn";
  onSelect: () => void;
};

const TONE: Record<SwipeRowAction["tone"], string> = {
  accent: "bg-accent text-accent-fg",
  danger: "bg-danger text-white",
  warn: "bg-warn text-white",
};

export function SwipeableRow({
  enabled,
  open,
  onOpenChange,
  leading = [],
  trailing = [],
  leadingFull = true,
  trailingFull = true,
  className,
  children,
}: {
  enabled: boolean;
  /** 父级持有的展开态（同时只允许一行） */
  open: RowSwipeSide | null;
  onOpenChange: (side: RowSwipeSide | null) => void;
  leading?: SwipeRowAction[];
  trailing?: SwipeRowAction[];
  /** 划到底直接执行：leading 执行第一个，trailing 执行最后一个（贴边那个） */
  leadingFull?: boolean;
  trailingFull?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const reduced = usePrefersReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [width, setWidth] = useState(320);
  const cfg: RowSwipeConfig = {
    leadingWidth: leading.length * ROW_ACTION_WIDTH,
    trailingWidth: trailing.length * ROW_ACTION_WIDTH,
    leadingFull: leadingFull && leading.length > 0,
    trailingFull: trailingFull && trailing.length > 0,
  };
  const base = useRef(0);
  const latest = useRef({ open, onOpenChange, cfg, leading, trailing });
  useEffect(() => {
    latest.current = { open, onOpenChange, cfg, leading, trailing };
  });

  const active = enabled && (leading.length > 0 || trailing.length > 0);
  // 关掉手势（转桌面 / 进入重命名）时顺手收回
  useEffect(() => {
    if (!active && latest.current.open) latest.current.onOpenChange(null);
  }, [active]);

  useSwipe(rootRef, {
    enabled: active,
    axis: "x",
    canStart: (e, el) => {
      const target = e.target as Element;
      // 露出的按钮自己负责点击；输入框（重命名）不抢
      if (target.closest("[data-row-swipe-action], input, textarea, [contenteditable=true]")) return false;
      if (startsInHorizontalScroller(target as HTMLElement, el, overflowX)) return false;
      base.current = restOffset(latest.current.open, latest.current.cfg);
      setWidth(el.clientWidth || 320);
      return true;
    },
    onMove: (delta) => {
      const el = rootRef.current;
      setDrag(dragOffset(base.current, delta, el?.clientWidth || width, latest.current.cfg));
    },
    onEnd: ({ delta, velocity }) => {
      const el = rootRef.current;
      const w = el?.clientWidth || width;
      const { cfg: c, leading: lead, trailing: trail, onOpenChange: change } = latest.current;
      const offset = dragOffset(base.current, delta, w, c);
      setDrag(null);
      const result = resolveRowSwipe({ offset, velocity, width: w, cfg: c });
      if (result === "open-leading") change("leading");
      else if (result === "open-trailing") change("trailing");
      else {
        change(null);
        if (result === "commit-leading") lead[0]?.onSelect();
        if (result === "commit-trailing") trail[trail.length - 1]?.onSelect();
      }
    },
  });

  // 展开时：点行外任意处收回；点行本身（非按钮）也只收回，吞掉随后的 click。Esc 同样收回。
  useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    let swallow = false;
    const onDown = (e: PointerEvent) => {
      // 同一行可能同时挂在桌面常驻栏（手机上 display:none）和抽屉里，open 是共享的；
      // 看不见的那份不参与「点外面收回」，否则点抽屉里的按钮会被它当成点外面。
      if (!root || root.getClientRects().length === 0) return;
      const t = e.target as Element | null;
      if (t?.closest("[data-row-swipe-action]") && root?.contains(t)) return;
      // 在本行上起手可能是要接着滑：交给 useSwipe，只在单击时收回
      if (root && t && root.contains(t)) {
        swallow = true;
        return;
      }
      latest.current.onOpenChange(null);
    };
    const onClick = (e: MouseEvent) => {
      if (!swallow) return;
      swallow = false;
      e.preventDefault();
      e.stopPropagation();
      latest.current.onOpenChange(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") latest.current.onOpenChange(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    root?.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      root?.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const offset = drag ?? restOffset(open, cfg);
  const armed = isFullArmed(offset, width, cfg);
  const animate = drag === null && !reduced;
  // 收回动画期间（offset 已归 0、按钮区宽度正在缩）还要画着上一次露出的那一侧，
  // 否则按钮瞬间消失、行滑回时底下是空的。按 React「渲染期调整 state」的写法记住它。
  const side: RowSwipeSide | null = offset > 0 ? "leading" : offset < 0 ? "trailing" : null;
  const [shownSide, setShownSide] = useState<RowSwipeSide | null>(null);
  if (side && side !== shownSide) setShownSide(side);
  // 没有动画（减少动态效果）就没有 transitionend，归 0 当场收起
  else if (!side && shownSide && !animate) setShownSide(null);
  const showLeading = shownSide === "leading" && leading.length > 0;
  const showTrailing = shownSide === "trailing" && trailing.length > 0;

  const renderActions = (actions: SwipeRowAction[], side: RowSwipeSide) => {
    const primary = side === "leading" ? actions[0] : actions[actions.length - 1];
    const full = side === "leading" ? cfg.leadingFull : cfg.trailingFull;
    return (
      <div
        data-row-swipe-actions={side}
        className={cn(
          "absolute inset-y-0 flex",
          side === "leading" ? "left-0 flex-row" : "right-0 flex-row",
        )}
        style={{ width: Math.abs(offset), transition: animate ? "width 180ms cubic-bezier(0.2, 0.8, 0.2, 1)" : "none" }}
      >
        {actions.map((a) => {
          // 划到底：主按钮撑满、其它让位，文案改成「松手…」
          const hidden = armed && full && a !== primary;
          if (hidden) return null;
          return (
            <button
              key={a.key}
              type="button"
              data-row-swipe-action={a.key}
              aria-label={a.label}
              // 只在展开态可聚焦 / 可点：跟手途中按钮还很窄
              tabIndex={open === side ? 0 : -1}
              onClick={(e) => {
                e.stopPropagation();
                onOpenChange(null);
                a.onSelect();
              }}
              onDoubleClick={(e) => e.stopPropagation()}
              className={cn(
                "flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 overflow-hidden text-nano font-medium",
                TONE[a.tone],
                armed && full ? "items-stretch px-4" : "",
              )}
            >
              <span
                className={cn(
                  "flex flex-col items-center gap-0.5 whitespace-nowrap",
                  armed && full ? (side === "leading" ? "self-start" : "self-end") : "",
                )}
              >
                <Icon icon={a.icon} size="sm" />
                {armed && full ? `松手${a.label}` : a.label}
              </span>
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div
      ref={rootRef}
      data-row-swipe={active ? (open ?? "closed") : undefined}
      className={cn("relative", active && "overflow-hidden rounded-md [-webkit-touch-callout:none]", className)}
      style={active ? { touchAction: "pan-y pinch-zoom" } : undefined}
    >
      {showLeading && renderActions(leading, "leading")}
      {showTrailing && renderActions(trailing, "trailing")}
      <div
        data-row-swipe-track
        className={active ? "relative bg-surface-canvas" : undefined}
        // 静止时 transform: none，不给行内容平白建 containing block
        style={
          active
            ? {
                transform: offset ? `translateX(${offset}px)` : "none",
                transition: animate ? "transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)" : "none",
              }
            : undefined
        }
        onTransitionEnd={(e) => {
          if (e.target === e.currentTarget && offset === 0) setShownSide(null);
        }}
      >
        {children}
      </div>
    </div>
  );
}
