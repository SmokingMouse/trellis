"use client";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "./cn";

// 展开 / 折叠的高度过渡（globals.css .ui-collapse：grid-template-rows 0fr → 1fr，
// --dur-base / --ease-out）。思考块、工具时间线、分支列表共用。
//
// 挂载策略与原来的 `{open && …}` 对齐：关着时不挂子树（大会话的工具时间线不能常驻
// DOM），只在「打开中 / 收起动画中」挂着。
//   - 打开：先以 0fr 挂上，下一帧切到 1fr，浏览器补间高度；
//   - 收起：立即切回 0fr，动画播完（CLOSE_MS）再卸载；
//   - 首次渲染就是打开的（流式中的工具面板），不播动画，直接落定。
// 收起中的内容 inert：不可聚焦、不可点，读屏跳过。
// 箭头用 .ui-collapse-chevron 与之同步旋转。

const CLOSE_MS = 300;
const SETTLE_MS = 300;

type DataAttributes = { [key: `data-${string}`]: string | undefined };

export function Collapse({
  open,
  children,
  className,
  innerClassName,
  ...rest
}: {
  open: boolean;
  children: ReactNode;
  /** 外层（grid 容器）的类：外边距放这里，收起时一并参与过渡 */
  className?: string;
  /** 内层（被压缩的那一格）的类 */
  innerClassName?: string;
} & DataAttributes) {
  const [mounted, setMounted] = useState(open);
  // shown：已经过了「0fr 的第一帧」，可以切到 1fr；settled：展开动画已播完。
  const [shown, setShown] = useState(open);
  const [settled, setSettled] = useState(open);
  if (open && !mounted) setMounted(true);

  useEffect(() => {
    if (open) {
      if (!shown) {
        let inner = 0;
        const outer = requestAnimationFrame(() => {
          inner = requestAnimationFrame(() => setShown(true));
        });
        return () => {
          cancelAnimationFrame(outer);
          cancelAnimationFrame(inner);
        };
      }
      if (settled) return;
      const t = window.setTimeout(() => setSettled(true), SETTLE_MS);
      return () => window.clearTimeout(t);
    }
    if (!mounted) return;
    // 收起中途又打开：settled 先复位，重新展开的那段动画照样裁切。
    const reset = requestAnimationFrame(() => setSettled(false));
    const t = window.setTimeout(() => {
      setMounted(false);
      setShown(false);
      setSettled(false);
    }, CLOSE_MS);
    return () => {
      cancelAnimationFrame(reset);
      window.clearTimeout(t);
    };
  }, [open, shown, settled, mounted]);

  if (!mounted) return null;
  const expanded = open && shown;
  return (
    <div
      {...rest}
      data-collapse=""
      data-open={expanded ? "" : undefined}
      data-settled={expanded && settled ? "" : undefined}
      aria-hidden={!open || undefined}
      inert={!open}
      className={cn("ui-collapse", className)}
    >
      <div className={innerClassName}>{children}</div>
    </div>
  );
}
