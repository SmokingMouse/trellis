// components/ui 原语统一出口。用法表见 docs/ui-redesign/primitives.md。
// 老代码的逐文件路径（@/components/ui/Button 等）继续可用，新代码从这里引。

// 基础
export { cn } from "./cn";
export { LayerContainerContext, useLayerContainer } from "./Layer";
export { Icon, ToolIcon, TOOL_ICONS, RefIcon, REF_ICONS, ICON_SIZE, type IconProps, type IconSize } from "./Icon";

// 按钮族
export { Button, buttonVariants, type ButtonProps, type ButtonVariant, type ButtonSize } from "./Button";
export { IconButton } from "./IconButton";
export { StopButton } from "./StopButton";
export { Tooltip, TooltipProvider, type TooltipProps } from "./Tooltip";
export { Kbd } from "./Kbd";
export { SearchSnippet } from "./SearchSnippet";

// 表单族
export { Input, Textarea, type InputProps } from "./Input";
export {
  Select,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
  SelectSeparator,
  type SelectOption,
} from "./Select";
export { Switch } from "./Switch";
export { Checkbox } from "./Checkbox";
export { Tabs, TabsList, TabsTrigger, TabsContent, SegmentedControl, type SegmentOption } from "./Tabs";

// 弹层族
export { Modal } from "./Modal";
export { Drawer } from "./Drawer";
export { Popover } from "./Popover";
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuGroup,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./DropdownMenu";
export {
  ContextMenu,
  useContextMenu,
  useContextMenuWithTarget,
  type ContextMenuAction,
  type ContextMenuItem,
  type ContextMenuPoint,
} from "./ContextMenu";
export { ConfirmDialog, ConfirmHost, confirmDialog, useConfirm, type ConfirmOptions } from "./ConfirmDialog";

// 反馈族
export { toast, Toaster } from "./Toaster";
export { Badge, type BadgeVariant } from "./Badge";
export { Pill } from "./Pill";
export { StatusDot, type StatusTone } from "./StatusDot";
export { Skeleton, SkeletonText } from "./Skeleton";
export { Spinner } from "./Spinner";
export { Dots } from "./Dots";
export { EmptyState } from "./EmptyState";
export { PageHeader } from "./PageHeader";
export { ErrorCallout } from "./ErrorCallout";

// 宿主
export { AppProviders } from "./AppProviders";
