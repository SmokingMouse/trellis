"use client";

// 「进行中」三点指示——全应用统一的 streaming/loading 视觉语汇
// （accent 色，CSS 在 globals.css 的 .trellis-dots）。
// tab 滑条(.trellis-run-bar)保留为 tab 专属补充；RunSpinner 环已退役。
export function Dots({ label = "生成中" }: { label?: string }) {
  return (
    <span className="trellis-dots shrink-0" aria-label={label} role="status">
      <span />
      <span />
      <span />
    </span>
  );
}
