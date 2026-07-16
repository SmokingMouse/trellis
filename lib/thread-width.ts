// 线性视图内容列宽度偏好（A4 sendKey 同款轻量偏好模式）。
// 只影响线性 thread 的三个对齐容器（顶栏/卡片列/Composer）；
// 画布 ChatNode 维持 600px（dagre 布局基准），不受此设置影响。
export type ThreadWidth = "narrow" | "wide" | "xwide";

export const THREAD_WIDTH_DEFAULT: ThreadWidth = "wide";

export function isThreadWidth(v: unknown): v is ThreadWidth {
  return v === "narrow" || v === "wide" || v === "xwide";
}

// Tailwind 按源码字面量扫描 class，必须写全名不能拼接。
export const THREAD_WIDTH_CLASS: Record<ThreadWidth, string> = {
  narrow: "max-w-3xl", // 768px，原固定值
  wide: "max-w-5xl", // 1024px
  xwide: "max-w-7xl", // 1280px
};

export const THREAD_WIDTH_OPTIONS: { value: ThreadWidth; label: string }[] = [
  { value: "narrow", label: "窄" },
  { value: "wide", label: "宽" },
  { value: "xwide", label: "超宽" },
];
