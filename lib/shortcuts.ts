// 快捷键单一注册表 —— KeyboardHelp 面板（? / /help）渲染的数据源。
// 新增快捷键时在此登记，别让能力散落在 placeholder/title 里不可发现。
//
// 同文件还提供 isEditableTarget()：单字母全局键（J/K/B/F/?）在输入区必须
// 让位的共享 guard——此前四处各自手写同一判断，易漂移。

export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!(
    el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.isContentEditable)
  );
}

export type Shortcut = {
  keys: string; // 展示用键位（⌘P / J·K / Alt+↑↓←→）
  label: string;
  scope: "全局" | "线性视图" | "画布" | "选中文字时" | "输入框";
};

export const SHORTCUTS: Shortcut[] = [
  { keys: "⌘P", label: "搜索 / 切换会话", scope: "全局" },
  { keys: "⌘1-9", label: "跳到第 N 个打开的标签", scope: "全局" },
  { keys: "J / K", label: "下一个 / 上一个未读节点（环绕）", scope: "全局" },
  { keys: "Alt+↑↓←→", label: "父 / 首子 / 兄弟节点导航", scope: "全局" },
  { keys: "Esc ×2", label: "中止正在生成的回答", scope: "全局" },
  { keys: "?", label: "打开本快捷键面板", scope: "全局" },
  { keys: "B", label: "跳回父节点锚点", scope: "线性视图" },
  { keys: "⌘J", label: "树面板：过滤跳转本会话节点", scope: "线性视图" },
  { keys: "F", label: "回全局视图（fit view）", scope: "画布" },
  { keys: "⌘K", label: "以选区为锚点分叉追问", scope: "选中文字时" },
  { keys: "⌘D", label: "摘选区为笔记", scope: "选中文字时" },
  { keys: "↩ / ⌘↩", label: "发送（可在输入框角标切换）", scope: "输入框" },
  { keys: "↑↓ + ↩/Tab", label: "/ 命令下拉导航与选中", scope: "输入框" },
  { keys: "Esc", label: "关闭弹层 / 取消分叉 chip", scope: "全局" },
];

// KeyboardHelp 面板的开启走 window 事件（不进 store）：
// `?` 键与 /help 命令都 dispatch 这个事件。
export const OPEN_HELP_EVENT = "trellis-open-help";

export function openKeyboardHelp() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(OPEN_HELP_EVENT));
  }
}
