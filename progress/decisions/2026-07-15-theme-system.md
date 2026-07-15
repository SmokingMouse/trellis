# 主题系统：语义 token 层 + 多主题皮肤（2026-07-15，Session 56）

## Context

UI 由 40+ 组件的内联 Tailwind 原子类构成，无 design token 层：~1900 处调色板
class + globals.css ~40 处裸 hex，dark 模式靠全组件 `dark:` 双写。静态审计
（两份，视觉 + 交互）结论：色相选择没问题，债在缺语义间接层——主按钮两套身份
（indigo 药丸 vs stone-900 黑底，17 文件）、「未读」amber/emerald 双色、amber
承担 mode-workspace/告警/分叉/未读四重语义、19 个任意字号档、弹层外壳手搓 7 套。
用户拍板：做主题系统（非一次性换装），视觉+交互+移动端一轮做透。

## Decision

1. **双层变量 + `@theme inline`**：原始变量（`--surface`/`--ink`/`--accent`…）
   定义在普通 CSS 块（`:root`/`.dark`/`[data-theme=X]`/`[data-theme=X].dark`）
   参与级联；`@theme inline` 注册成 utility（`bg-surface` 等）。`inline` 是
   正确性关键——不加则 var 解析静态值、不随主题级联。
2. **词表**：中性族 surface/line/ink（强度后缀）+ 语义 hue（accent/warn/danger/
   positive/unread/fork/mode-chat/mode-workspace/mode-project，角色后缀
   X/-strong/-ink/-muted/-line）+ CSS-only 变量（--code-*/--mark-*/--edge/
   --accent-vivid）。字号 6 档、圆角 3 档、阴影 3 档、z 约定阶梯。
3. **语义拆分裁决**：amber 四分（mode-workspace / fork / warn / 未读→unread）；
   rose 二分（mode-project / danger）；emerald 二分（unread / positive）。
   **未读=emerald 统一**（节点级 amber 未读废除；compact 已读侧条改中性避免
   与 unread 撞色）；**笔记 UI=emerald**（NoteRow amber 卡废除，与 note mark
   归一）；**主按钮=accent 填充**（黑底按钮身份废除——accent 已是焦点/流式/
   选中的既定身份，且随主题换肤）；**代码块恒暗**（hljs light 层本就是被
   layer 顺序压死的死代码，据实确立为设计决策，删 light import）。
4. **主题 = 变量覆盖块**：一套主题 = `[data-theme=X]` + `[data-theme=X].dark`
   两个 CSS 块 + `lib/themes.ts` 注册表一行；新增边际成本 ≈ 一个 CSS 块。
   ⚠️ 级联规则：light 块设过的变量 dark 块必须全部重设（data-theme 选择器
   声明在 `.dark` 之后同优先级）。首发 4 套：paper/terminal/morandi/contrast。
5. **状态**：useTheme = {mode: light|dark|system, palette}，storage 兼容零迁移
   （旧 'trellis-theme' 二值天然合法，缺省=system；新增 'trellis-palette'）；
   模块级 setThemeMode/Palette + 轻量 pub/sub，**不建 ThemeContext**——主题
   切换 = html class/attr 变更纯 CSS 重绘，ChatNode 零重渲染纪律不受影响。
6. **回归护栏（W5.5 闸门）**：`@theme` 里 `--color-stone-*: initial` 等禁用六个
   已迁移原生色族——漏写的调色板 class 不再生成 utility、视觉直接显形。
   品牌固定色（Logo 渐变）用任意值 hex 写法豁免。
7. **共享原语 components/ui/**：Button/IconButton/Popover/Modal/Drawer/
   ToastShell/Pill/StopButton/Dots 九件，全部只用 token utility；弹层/抽屉/
   toast 的 7 套手搓外壳收编，进场动画内置（reduced-motion 豁免）。

## Rationale

- token 值精确取 Tailwind v4 oklch 原值 → 迁移零视觉 diff 可验证（浏览器
  computed-style 逐字节断言 + 截图 diff 双证）。
- mode 色与状态色解耦成独立变量 → 换肤可只动 mode 不碰告警语义（morandi
  的降饱和状态色即受益）。
- opacity modifier（`bg-surface/50`）实测可用：Tailwind 4.2.4 编译为
  `color-mix(in oklab, var(--x) N%, transparent)`，使用处解析随主题级联。

## Alternatives

- 组件里继续 `dark:` 双写 + 每主题一套 class 映射：加主题 = 全组件改写，弃。
- CSS-in-JS / ThemeContext：引入运行时开销 + 破坏 ChatNode 零重渲染纪律，弃。
- 只换装不建系统：branch 名就叫 trellis-theme，用户明确要多主题，弃。

## Consequences

- 组件层写颜色只允许语义 token；原生色族 utility 已禁用（W5.5 闸门），漏网
  即显形。新增语义先进 globals.css 词表 + @theme 注册，再消费。
- 断点纪律：布局断点只看宽度且与 `md:` 同线（useIsMobile=767px）；pointer
  能力判定另用独立 query，不混入布局。
- 快捷键必须登记 `lib/shortcuts.ts`（? 面板的数据源）；输入区 guard 统一走
  `isEditableTarget()`。
- 交互面（同日 W7）：SessionTabs 移动端隐藏、RunSpinner 退役（Dots 统一）、
  TargetChip 归一、🧠 徽章恒按钮、「新会话 vs 新话题」正名。
