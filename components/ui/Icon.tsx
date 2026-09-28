import {
  Bot,
  Check,
  ClipboardList,
  CircleQuestionMark,
  Dot,
  FilePen,
  FileText,
  Globe,
  List,
  ListChecks,
  Mail,
  NotebookPen,
  Pencil,
  Plug,
  Plus,
  Search,
  Square,
  SquareSlash,
  Target,
  Terminal,
  Timer,
  Toolbox,
  Workflow,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";
import type { ToolIconKey } from "@/lib/tool-registry";
import { cn } from "./cn";

// 图标原语：全站 lucide 图标统一走这里，尺寸与线宽只有这几档。
//   sm = 14px（行内 / 表格 / 工具行首）  md = 16px（按钮 / 导航，默认）  lg = 18px
//   线宽 1.75；选中态（selected）加粗到 2。
// emoji 只留给用户内容；界面上的符号一律换成 lucide（W3/W4 按文件域迁移）。

export const ICON_SIZE = { sm: 14, md: 16, lg: 18 } as const;
export type IconSize = keyof typeof ICON_SIZE;

export type IconProps = Omit<LucideProps, "size"> & {
  icon: LucideIcon;
  size?: IconSize;
  /** 选中 / 激活态：线宽 1.75 → 2 */
  selected?: boolean;
};

export function Icon({ icon: Glyph, size = "md", selected = false, className, ...rest }: IconProps) {
  const labelled = rest["aria-label"] !== undefined;
  return (
    <Glyph
      size={ICON_SIZE[size]}
      strokeWidth={selected ? 2 : 1.75}
      aria-hidden={labelled ? undefined : true}
      className={cn("shrink-0", className)}
      {...rest}
    />
  );
}

// 工具时间线行首图标。lib/tool-registry.ts 只存 key（它也被 API route 引用，
// 不能带 React 组件），这里把 key 映射成 lucide 组件；Record 类型保证新增
// key 时漏配会编译失败。
export const TOOL_ICONS: Record<ToolIconKey, LucideIcon> = {
  terminal: Terminal,
  stop: Square,
  file: FileText,
  "file-pen": FilePen,
  pencil: Pencil,
  notebook: NotebookPen,
  search: Search,
  globe: Globe,
  toolbox: Toolbox,
  bot: Bot,
  workflow: Workflow,
  "list-checks": ListChecks,
  clipboard: ClipboardList,
  question: CircleQuestionMark,
  target: Target,
  slash: SquareSlash,
  plus: Plus,
  check: Check,
  list: List,
  mail: Mail,
  plug: Plug,
  timer: Timer,
  dot: Dot,
};

export function ToolIcon({
  name,
  size = "sm",
  className,
}: {
  name: ToolIconKey;
  size?: IconSize;
  className?: string;
}) {
  return <Icon icon={TOOL_ICONS[name] ?? Dot} size={size} className={className} />;
}
