"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { ChevronUp } from "lucide-react";
import { Button, Icon, cn } from "@/components/ui";

// 回答正文里的图表：按原始尺寸展示，比正文栏宽才等比缩到栏宽（不再把小图拉大）；
// 特别高的图折叠到视口高度的 70%，底部渐隐 +「展开全图」。点图打开全屏查看器。
// 刻意用静态 <img>：不劫持滚轮（正文照常滚），也和卡片图导出走同一条 <img> 路径。

const clampCap = () =>
  typeof window === "undefined"
    ? 560
    : Math.round(Math.min(900, Math.max(420, window.innerHeight * 0.7)));

export function DiagramPreview({
  src,
  width,
  height,
  alt,
  onOpen,
  stale = false,
}: {
  src: string;
  /** 固有尺寸；0 = 未知（交给浏览器按图片自身尺寸排） */
  width: number;
  height: number;
  alt: string;
  onOpen: () => void;
  /** 源码已变、新图还在路上（流式输出中）：旧图半透明提示 */
  stale?: boolean;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [frameW, setFrameW] = useState(0);
  const [cap, setCap] = useState(560);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => {
      setFrameW(el.clientWidth);
      setCap(clampCap());
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = frameW > 0 && width > 0 ? Math.min(1, frameW / width) : 1;
  // 只高出一点点不值得折叠
  const collapsible = height > 0 && height * scale > cap * 1.15;
  const collapsed = collapsible && !expanded;

  return (
    <div
      ref={frameRef}
      data-diagram-frame
      className={cn("relative w-full", collapsed && "overflow-hidden")}
      style={collapsed ? { maxHeight: cap } : undefined}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        className="nodrag mx-auto block w-fit max-w-full cursor-zoom-in rounded-field"
        aria-label="放大查看图表"
        title="点击放大查看"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          width={width || undefined}
          height={height || undefined}
          draggable={false}
          className={cn("block h-auto max-w-full transition-opacity", stale && "opacity-60")}
        />
      </button>
      {scale < 0.9 && (
        <span
          data-diagram-chrome
          className="pointer-events-none absolute right-0 top-0 rounded-sm bg-surface-raised px-1 font-mono text-nano text-ink-faint"
        >
          {Math.round(scale * 100)}%
        </span>
      )}
      {collapsed && (
        <div
          data-diagram-chrome
          className="absolute inset-x-0 bottom-0 flex h-24 items-end justify-center bg-gradient-to-t from-surface via-surface/80 to-transparent pb-2"
        >
          <Button
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(true);
            }}
          >
            展开全图
          </Button>
        </div>
      )}
      {collapsible && expanded && (
        <div data-diagram-chrome className="mt-2 flex justify-center">
          <Button
            size="sm"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(false);
            }}
          >
            <Icon icon={ChevronUp} size="sm" />
            收起
          </Button>
        </div>
      )}
    </div>
  );
}
