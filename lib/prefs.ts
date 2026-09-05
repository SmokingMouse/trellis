// S89: 本机偏好的 key 名唯一真源 + 「可穷举清单」的元数据。
//
// 这个文件**不接管读写逻辑** —— 各处的 state / store 保持原样。它只解决两件事：
//
// ① key 名散在 6 个文件里各写一遍。真出过事的是 `trellis-theme` / `trellis-palette`：
//    hooks/useTheme.ts 和 app/layout.tsx 的首屏防闪脚本各硬编码一份，layout 里还留了
//    「keep them in sync if you change either」的注释 —— 那种「靠人记得同步」的约定迟早失效。
//    现在 layout 的脚本从这里的常量**生成**，物理上不可能不同步。
//
// ② 「我知道有这个设置，但找不到在哪改」。偏好从 S62 评估时的几个涨到今天的二十多个，
//    全部只存在于语境化的 popover 和输入框脚注里，没有任何地方能穷举。
//    PREF_ITEMS 就是给管理台「偏好」tab 用的镜像清单。
//
// **刻意不做的**：不把原地控件搬进管理台。语境化仍是主路径（主题在 ThemeMenu、发送键在
// composer 脚注、宽度在线性视图顶栏），镜像只是多一个能通览、能改的地方。这半条来自
// decisions.md 2026-07-29，至今成立；被修订的只是「偏好少所以不需要穷举」那半条。

import { PALETTES } from "@/lib/themes";

/** 全部 localStorage key 名。别在别处再写字面量。 */
export const PREF_KEYS = {
  // 外观
  theme: "trellis-theme",
  palette: "trellis-palette",
  // 输入
  sendKey: "trellis-send-key",
  historyDepth: "trellis-history-depth",
  historyDepthMigrated: "trellis-history-depth-migrated",
  chatEnhanced: "trellis-chat-enhanced",
  // 版式
  threadWidth: "trellis-thread-width",
  treePanelView: "trellis-tree-panel-view",
  sidebarOpen: "trellis-sidebar-open",
  sidebarWidth: "trellis-sidebar-width",
  sidebarCollapsed: "trellis-sidebar-collapsed",
  termHeight: "trellis-term-height",
  termOpen: "trellis-term-open",
  termPinned: "trellis-term-pinned",
  // 新会话默认值（草稿，建会话时锁进 session 行）
  provider: "trellis-provider",
  mode: "trellis-mode",
  workspace: "trellis-workspace",
  systemPrompt: "trellis-system-prompt",
  agentId: "trellis-agent-id",
  requireApproval: "trellis-require-approval",
  // 其它
  pinnedSessions: "trellis-pinned-sessions",
} as const;

export type PrefKey = (typeof PREF_KEYS)[keyof typeof PREF_KEYS];

/** per-session 的动态 key。它们数量随会话增长，不进清单。 */
export const sessionScopedKey = {
  collapsed: (sid: string) => `trellis-collapsed:${sid}`,
  treeVisits: (sid: string) => `trellis-tree-visits:${sid}`,
  view: (sid: string) => `trellis-view:${sid}`,
};

// ── 镜像清单的元数据 ─────────────────────────────────────────────────────────

export type PrefItem = {
  key: PrefKey;
  label: string;
  /** 这个偏好原本在哪改。清单的作用是**指路**，不是取代 —— 说清出处比自己再实现一遍重要。 */
  where: string;
  group: "外观" | "输入" | "版式" | "新会话默认";
} & (
  | { kind: "enum"; options: { value: string; label: string }[]; fallback: string }
  | { kind: "bool"; fallback: boolean }
  | { kind: "readonly" }
);

export const PREF_ITEMS: PrefItem[] = [
  {
    key: PREF_KEYS.theme,
    label: "外观模式",
    where: "Header 的 ☀ 主题菜单",
    group: "外观",
    kind: "enum",
    fallback: "system",
    options: [
      { value: "system", label: "跟随系统" },
      { value: "light", label: "浅色" },
      { value: "dark", label: "深色" },
    ],
  },
  {
    key: PREF_KEYS.palette,
    label: "主题皮肤",
    where: "Header 的 ☀ 主题菜单",
    group: "外观",
    kind: "enum",
    fallback: "default",
    options: PALETTES.map((p) => ({ value: p.id, label: p.label })),
  },
  {
    key: PREF_KEYS.sendKey,
    label: "发送快捷键",
    where: "新会话「更多设置」/ 会话输入框脚注",
    group: "输入",
    kind: "enum",
    fallback: "mod-enter",
    options: [
      { value: "mod-enter", label: "⌘Enter 发送 / Enter 换行" },
      { value: "enter", label: "Enter 发送 / ⌘Enter 换行" },
    ],
  },
  {
    key: PREF_KEYS.historyDepth,
    label: "上下文历史深度",
    where: "新会话「更多设置」/ 会话输入框 📚 脚注",
    group: "输入",
    kind: "enum",
    fallback: "0",
    options: [
      { value: "0", label: "全发（历史留在 CLI 会话里，缓存友好、不失忆）" },
      { value: "2", label: "折叠 2 层" },
      { value: "4", label: "折叠 4 层" },
      { value: "6", label: "折叠 6 层" },
      { value: "8", label: "折叠 8 层" },
    ],
  },
  {
    key: PREF_KEYS.chatEnhanced,
    label: "chat 增强模式",
    where: "新会话「更多设置」（仅 chat 可见）",
    group: "输入",
    kind: "bool",
    fallback: false,
  },
  {
    key: PREF_KEYS.threadWidth,
    label: "线性视图内容宽度",
    where: "线性视图顶栏的 窄 / 宽 / 超宽",
    group: "版式",
    kind: "enum",
    fallback: "wide",
    options: [
      { value: "narrow", label: "窄" },
      { value: "wide", label: "宽" },
      { value: "xwide", label: "超宽" },
    ],
  },
  {
    key: PREF_KEYS.treePanelView,
    label: "树面板形态",
    where: "线性视图右下「树」面板展开后标题栏的小图标",
    group: "版式",
    kind: "enum",
    fallback: "list",
    options: [
      { value: "list", label: "列表" },
      { value: "graph", label: "图形" },
    ],
  },
  {
    key: PREF_KEYS.sidebarOpen,
    label: "侧栏默认展开",
    where: "侧栏自身的展开 / 收起按钮",
    group: "版式",
    kind: "bool",
    fallback: true,
  },
  {
    key: PREF_KEYS.termPinned,
    label: "终端钉住（dock 态）",
    where: "终端面板右上角的钉图标",
    group: "版式",
    kind: "bool",
    fallback: false,
  },
  // 新会话默认值：只读展示。它们是「上次选了什么」的记忆，在这里改没有意义
  // —— 下一次开会话时那三个 picker 才是真正的入口，且它们要连带做一致性钳制
  // （chat 清 workspace、选 agent 清 systemPrompt）。
  { key: PREF_KEYS.provider, label: "默认模型", where: "Header 模型下拉", group: "新会话默认", kind: "readonly" },
  { key: PREF_KEYS.mode, label: "默认上下文模式", where: "新会话摘要 /「更多设置」", group: "新会话默认", kind: "readonly" },
  { key: PREF_KEYS.workspace, label: "默认工作区", where: "新会话摘要 /「更多设置」", group: "新会话默认", kind: "readonly" },
  { key: PREF_KEYS.agentId, label: "默认 Agent", where: "新会话「更多设置」", group: "新会话默认", kind: "readonly" },
  { key: PREF_KEYS.requireApproval, label: "默认审批开关", where: "新会话「更多设置」", group: "新会话默认", kind: "readonly" },
];

// ── 读写（只给镜像清单用；各组件保持自己的 state 逻辑不变）──────────────────

export function readRaw(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeRaw(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 隐私模式 / 配额满：偏好写不进去不该让页面炸 */
  }
}
