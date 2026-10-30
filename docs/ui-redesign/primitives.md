# UI 原语用法表（W2 · 2026-09-28）

给 W3/W4 迁移用。新代码一律 `import { … } from "@/components/ui"`；旧的逐文件路径继续可用。
颜色只用语义 utility（`bg-surface` / `text-ink-muted` / `border-line` …），不写 hex、不写 Tailwind 原生色族（`lib/tailwind-color-guard.test.ts` 会拦）。

## 全局约定

| 项 | 约定 |
|---|---|
| 控件高度 | md = 32px（`min-h-8`），sm = 26px（`min-h-6.5`）；手机端（`max-md`）≥44px 热区由原语自带 |
| 字号 | 控件 `text-ui`（13px），小号 / meta `text-label`（12px），键帽 `text-nano` |
| 圆角 | chip / 行内标签 `rounded-chip`(6)，按钮 / 输入 `rounded-field`(8)，卡片 `rounded-card`(10)，下拉 / popover `rounded-overlay`(10)，主窗 / modal / 输入框 / 命令面板 `rounded-window`(14) |
| 阴影 | 2026-10-30 起改用 beautifului 叠层阴影：`shadow-hairline`（1px ring）、`shadow-btn`（次按钮 / chip）、`shadow-raise`（卡片）、`shadow-pop`（下拉）、`shadow-overlay`（modal / toast）、`shadow-primary`（实底按钮顶部高光）、`shadow-inset-field`（输入框）。这几档**自带 1px ring**，同一元素别再叠 `border border-line` |
| hover 底 | `bg-surface-hover`（新 token，替代各处 `hover:bg-surface-muted`） |
| 焦点 | 全局 `:focus-visible` 描边；输入类额外 `ring-2 ring-focus-ring` |
| 动效 | 弹层 160ms 从 0.95 放大淡入（`.ui-layer`，`--ease-out-strong`）；内容进场 `.ui-enter-up`（上浮 8px，380ms，列表 40–80ms 错峰）；按钮只变色，**不许 `active:scale-*`**（触屏按压走 `.press`） |
| 分层 z | 浮窗 `z-20` < popover / 菜单 / Select / Drawer `z-50` < Modal / 确认框 `z-60` < Toast / Tooltip `z-70` |
| 嵌套弹层 | Modal / Drawer 经 `LayerContainerContext` 下发容器，里面的 Select / Tooltip / Popover / DropdownMenu 自动 portal 进去，不用手调 z |
| 覆盖规则 | 没有 tailwind-merge：`className` 别和原语写同一属性的另一档（例：别给 Button 再写 `text-sm`），要改尺寸用 `size` |

## 原语一览

| 原语 | 何时用 | 关键 props | 禁止的旧写法 |
|---|---|---|---|
| `Button` | 一切文字按钮 | `variant` primary / ink（墨色实底，页面级主操作） / secondary(默认) / ghost / danger(描边) / danger-solid(**仅确认框**) / link；`size` sm / md / icon；`loading`；`asChild`（包 `<a>` / `Link`） | 裸 `<button className="px-… bg-accent …">`；`active:scale-95`；loading 时把文字改成「加载中…」 |
| `IconButton` | 只有图标的按钮 | `label`（**必填**，作 aria-label + tooltip）；`shortcut`；`size` sm / md；`tone` neutral / danger；`tooltip={false}` 关掉 | 无名图标按钮；原生 `title` 当 tooltip |
| `Tooltip` | 给图标 / 截断文字补名字 + 快捷键 | `content`、`shortcut`、`side` | `title=` 属性；在 tooltip 里放可点内容（那是 Popover） |
| `Kbd` | 快捷键键帽 | children 或 `keys={["⌘","K"]}` | 手写 `<span className="border rounded px-1 font-mono">` |
| `Input` / `Textarea` | 文本输入 | `size` sm / md；`invalid`；`leading` / `trailing`（放大镜、清除） | 手写 `border … focus:ring-…` 的 input |
| `Select` | 从固定选项里选一个 | 简单：`options`、`value`、`onValueChange`；组合：`SelectRoot/Trigger/Content/Item` | 原生 `<select>`（新代码）；value 用空串（Radix 不允许，用哨兵值） |
| `Switch` | 即时生效的开关 | Radix `checked` / `onCheckedChange` | 两态按钮冒充开关 |
| `Checkbox` | 表单 / 批量选择 | `checked`（可 `"indeterminate"`）；外层 `<label>` 包文字 | 原生 checkbox（新代码） |
| `Tabs` | 同一位置切换不同面板 | `Tabs` + `TabsList` + `TabsTrigger` + `TabsContent` | 一排手写按钮 + `useState` 切面板 |
| `SegmentedControl` | 同一份数据换视图 / 排序（侧栏「按项目 / 按时间」） | `value`、`onValueChange`、`options`（可带 `icon`）、`aria-label`（必填） | 手写 pill 组 |
| `Modal` | 居中弹窗 | `onClose`、`size` md / lg / full（铺满视口的查看器，如图表全屏）、`closeOnEsc`、`panelClassName`、`title`（读屏名） | 手写 `fixed inset-0 bg-scrim/50` 外壳；`z-[60]` 之类 |
| `Drawer` | 右侧面板 / 手机底部 sheet | `open`、`onClose`、`widthClassName`、`title` | 手写滑入面板 |
| `Popover` | trigger 旁的自由内容面板（搜索、表单、说明） | `trigger`、`open`、`onClose`、`align`、`panelClassName` | 手写 `absolute right-0 mt-1 …` 下拉；面板里的字号颜色依赖继承（已 portal，不再继承） |
| `DropdownMenu` | 点按钮弹出动作 / 单选 / 多选列表 | `DropdownMenuTrigger asChild` + `Content` + `Item`（`icon`、`shortcut`、`danger`）/ `CheckboxItem` / `RadioItem` | 用 Popover 手搓菜单项和方向键 |
| `ContextMenu` | 右键 / 长按菜单 | `useContextMenu()` / `useContextMenuWithTarget()` | — |
| `ConfirmDialog` / `useConfirm` | 需要用户确认的动作 | `const confirm = useConfirm(); if (!(await confirm({ title: "删除这棵树？", description: "树里的节点和笔记会一起删除，无法恢复。", danger: true }))) return;` | `window.confirm`（W4 全部替换）；标题写成陈述句；不写后果 |
| `toast` | 操作结果的短暂反馈 | `toast.success / error / warning / info / loading / promise`；`{ description, action: { label, onClick } }` | 新建 toast 组件；`DoneToast` 式手写定位（旧四套 W4 迁移） |
| `Badge` | 计数 / 标签 / 状态 | `variant` neutral(默认) / accent / positive / warn / danger / fork / unread；`dot` | 彩色实心徽标；新代码用 `Pill` |
| `StatusDot` | 6px 状态圆点 | `tone`（含 live 呼吸、attention 琥珀呼吸「等你处理」、idle 空心；positive 带同色光晕）；`label`（读屏） | 手写 `w-1.5 h-1.5 rounded-full bg-…` |
| `Skeleton` / `SkeletonText` | 首次加载占位 | 尺寸走 `className`；`lines` | 「加载中…」纯文字；手写 `animate-pulse` 块 |
| `PixelLoader` | 长时间运行的状态（正在运行卡、运行中的轮次、任务行） | `size` sm / md；`round`；`label` | 用 Spinner 表示「在跑」；手写闪烁点阵 |
| `GlideList` | 一组可悬停的行（侧栏、设置导航、菜单列表），高亮块跟着指针滑 | 行上标 `data-glide-row`；其余透传 div props | 每行各写 `hover:bg-…` 的长列表 |
| `Spinner` | 按钮 / 短加载的转圈 | `size` sm / md / lg；`label`（装饰性传 null） | 手写 `animate-spin` svg / 边框环。流式「生成中」仍用 `Dots` |
| `EmptyState` | 列表为空 | `icon`（lucide）、`title`「还没有 X」、`description`、`action`、`compact` | 一行灰字「暂无数据」 |
| `PageHeader` | 管理页页头 | `title`、`count` + `countUnit`（进副标题）、`subtitle`、`actions`（刷新 → 主操作） | 各页自拼 h1 |
| `ErrorCallout` | 展示失败 | `error`（任意）、`title` / `hint` 覆盖、`onRetry`、`action` | 直接渲染 `e.message` / `String(err)` |
| `Icon` | 界面图标 | `icon`（lucide 组件）、`size` sm 14 / md 16 / lg 18、`selected`（线宽 2） | emoji 当图标；直接 `<Search size={13} strokeWidth={2.5}>` 自定尺寸线宽 |

## 迁移备忘

- 工具时间线行首已换 lucide：`lib/tool-registry.ts` 存 `ToolIconKey`，映射在 `components/ui/Icon.tsx` 的 `TOOL_ICONS`；新增工具时两边都要加（漏了编译报错）。
- `Popover` 面板 portal 到 body 后不再继承 trigger 附近的字号 / 颜色：默认 `text-ui text-ink`，要别的写进 `panelClassName`。
- `Modal` / `Drawer` 是 Radix 的 `modal={false}`（不锁 body 指针、不 aria-hide 其余 DOM），Tab 循环自己做——原因见 `components/ui/focus.ts`。等 FilePreview / CodeBlock 全屏 / ContextMenu / 旧 toast 这些非 Radix 浮层都迁完，可以考虑切回 Radix 的 modal 模式。
- `Button` 的 `danger` 从实心红改成了描边红字；真正的「确认删除」请走 `useConfirm({ danger: true })`。
