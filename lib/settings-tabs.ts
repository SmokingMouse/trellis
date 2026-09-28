// S89: 管理台的 tab 定义 —— schema 与 UI 的唯一真相源（照 lib/agent-presets.ts 的先例）。
//
// 这张表决定的不只是渲染顺序，还有「/settings 落到哪个 tab」（= 第一条）。加一个持久对象
// 时改这里一行，不要再往 Header 上加图标、也不要再开一张顶级整页 —— 那正是 S88 之后
// Agent 和任务各自散成一页的成因（见 decisions/2026-07-31-console-ia.md 决策 3）。
//
// 判据（决定一个东西该不该进这张表）：有 CRUD、跨 session 存活、被 id 引用 = 持久对象 → 进；
// 创建时锁定的当下语境（mode/workspace/model）→ 留在原地的 picker 里，不进。

// 图标只存 key 不存 lucide 组件：这张表也被 next.config.ts 引用（/settings 重定向取第一条），
// 配置加载期不该拖进 React / lucide。key → 组件的映射在 components/SettingsNav.tsx，
// 用 Record 保证新增 key 漏配时编译失败（同 lib/tool-registry.ts 的做法）。
export type SettingsTabIconKey =
  | "bot"
  | "calendar-clock"
  | "cpu"
  | "messages-square"
  | "share"
  | "square-terminal"
  | "server"
  | "sliders"
  | "circle-arrow-up";

/** 导航分组。顺序即渲染顺序。 */
export const SETTINGS_TAB_GROUPS = [
  { id: "automation", label: "Agent 与自动化" },
  { id: "connect", label: "连接" },
  { id: "system", label: "系统" },
] as const;

export type SettingsTabGroup = (typeof SETTINGS_TAB_GROUPS)[number]["id"];

export type SettingsTab = {
  /** URL 段：/settings/<segment> */
  segment: string;
  label: string;
  /** 所属分组（导航里的小标题） */
  group: SettingsTabGroup;
  /** tab 上的图标 key（lucide），纯装饰，aria-hidden。 */
  icon: SettingsTabIconKey;
  /** hover 提示，说清这个 tab 管的是什么 */
  title: string;
};

// 顺序 = 分组顺序 × 组内顺序；第一条同时是 /settings 的落点（仍是 agents）。
export const SETTINGS_TABS: SettingsTab[] = [
  {
    segment: "agents",
    label: "Agent",
    group: "automation",
    icon: "bot",
    title: "自定义人设：系统提示词、技能、模型、工具白/黑名单",
  },
  {
    segment: "tasks",
    label: "自动化任务",
    group: "automation",
    icon: "calendar-clock",
    title: "定时 / 事件触发的任务定义与运行历史",
  },
  {
    segment: "models",
    label: "模型与服务商",
    group: "automation",
    icon: "cpu",
    title: "endpoints.yaml 的图形入口：服务商、端点 URL、API Key、模型列表（跨 sm-toolkit 共享）",
  },
  {
    segment: "bots",
    label: "飞书机器人",
    group: "connect",
    icon: "messages-square",
    title: "飞书自建应用、Agent 与工作目录绑定、连接状态和会话入口",
  },
  {
    segment: "shares",
    label: "共享池",
    group: "connect",
    icon: "share",
    title: "模型与 Token 共享池：发布与订阅 Claude Token 或大模型 API 端点",
  },
  {
    segment: "workspaces",
    label: "工作区与 CLI",
    group: "connect",
    icon: "square-terminal",
    title: "工作区通览与 worktree 回收、CLI 会话接入",
  },
  {
    segment: "machine",
    label: "机器资源",
    group: "system",
    icon: "server",
    title: "Trellis 服务所在机器的 CPU、内存与工作目录磁盘状态",
  },
  {
    segment: "prefs",
    label: "偏好",
    group: "system",
    icon: "sliders",
    title: "主题、发送键、上下文深度等本机偏好的可穷举清单",
  },
  {
    segment: "update",
    label: "版本与更新",
    group: "system",
    icon: "circle-arrow-up",
    title: "当前版本、落后的提交、一键更新与回滚",
  },
];

/** /settings 裸路径落到哪个 tab。取第一条，别单独写死一个常量。 */
export const DEFAULT_SETTINGS_TAB = SETTINGS_TABS[0].segment;
