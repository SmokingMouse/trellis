"use client";
import { useRef, useState, type ComponentProps, type PointerEvent } from "react";
import { cn } from "./cn";

// 悬停滑块（beautifului.dev Sidebar Nav 的 GlideMenu，MIT）：一块高亮跟着指针
// 在行之间滑动，而不是每行各自变色。行用 data-glide-row 标记；滑块在场时
// 行自身的 hover 底色让位（globals.css .ui-glide）。只响应鼠标 / 触控板——
// 触屏没有 hover，pointerType=touch 直接忽略，按压反馈仍走 .press-row。

type Rect = { x: number; y: number; w: number; h: number };

export function GlideList({
  className,
  children,
  onPointerMove,
  onPointerLeave,
  ...rest
}: ComponentProps<"div">) {
  const ref = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<Rect | null>(null);

  const move = (e: PointerEvent<HTMLDivElement>) => {
    onPointerMove?.(e);
    if (e.pointerType === "touch") return;
    const root = ref.current;
    const row = (e.target as Element).closest<HTMLElement>("[data-glide-row]");
    if (!root || !row || !root.contains(row)) return;
    const r = root.getBoundingClientRect();
    const b = row.getBoundingClientRect();
    const next = { x: b.left - r.left, y: b.top - r.top + root.scrollTop, w: b.width, h: b.height };
    setRect((cur) =>
      cur && cur.x === next.x && cur.y === next.y && cur.w === next.w && cur.h === next.h ? cur : next,
    );
  };

  return (
    <div
      ref={ref}
      className={cn("ui-glide", className)}
      data-gliding={rect ? "" : undefined}
      onPointerMove={move}
      onPointerLeave={(e) => {
        onPointerLeave?.(e);
        setRect(null);
      }}
      {...rest}
    >
      <span
        aria-hidden
        className="ui-glide-hl"
        style={
          rect
            ? { transform: `translate(${rect.x}px, ${rect.y}px)`, width: rect.w, height: rect.h }
            : undefined
        }
      />
      {children}
    </div>
  );
}
