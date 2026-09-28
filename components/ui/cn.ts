// 类名拼接：过滤掉 false / null / undefined。没引 tailwind-merge ——
// 原语的基础类与调用方 className 冲突时，由调用方避免写同一属性的两档
// （见 docs/ui-redesign/primitives.md「覆盖规则」）。
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
