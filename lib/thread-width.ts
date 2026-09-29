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

// 与上面 max-w-* 一一对应的实际宽度，给「按需给树浮窗让位」的 calc 用。
export const THREAD_WIDTH_CSS: Record<ThreadWidth, string> = {
  narrow: "48rem",
  wide: "64rem",
  xwide: "80rem",
};

/**
 * 正文列右侧给树浮窗（宽 S = --trellis-tree-safe）让出的 padding：只让「不让就会被盖住」的那部分。
 * 列在 (W - p) 里居中，右侧留白 = (W - col + p) / 2，要 ≥ S ⇒ p = clamp(0, 2S - W + col, S)。
 * 上限 S：列已经撑满 (W - S) 时，再多让只会把正文压窄（等同旧行为：整块让出 S）。
 * 宽屏时 p = 0，列在侧栏右侧的整块区域里居中（左右对称）；屏幕变窄才逐步左移。
 * 百分比按包含块宽度（= 线性视图可用宽度 W）计算，所以只能用在它的直接子元素上。
 */
export function treeSafePadding(width: ThreadWidth): string {
  return `clamp(0px, calc(2 * var(--trellis-tree-safe, 0px) - 100% + ${THREAD_WIDTH_CSS[width]}), var(--trellis-tree-safe, 0px))`;
}

export const THREAD_WIDTH_OPTIONS: { value: ThreadWidth; label: string }[] = [
  { value: "narrow", label: "窄" },
  { value: "wide", label: "宽" },
  { value: "xwide", label: "超宽" },
];
