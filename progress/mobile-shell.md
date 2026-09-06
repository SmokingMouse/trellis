# 手机精简壳

状态：M1 / M2 / M11 已实现。规格依据为主仓审计
`/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-audit-f928/out/audit.md`
的 §1、§3、§4、§5。

## 手机首屏信息裁决

| 必须留在一级界面 | 收入 overflow / 高级设置 / 桌面版 |
|---|---|
| 会话 drawer 入口、当前会话短标题、overflow | 搜索、思维树、画布、工作区文件、笔记、导出 |
| 回答正文与最小阅读动作 | mode badge、模型、主题、任务、设置、管理后台 |
| Composer、附件、发送；运行时停止 | CLI resume、重生成、分享卡等低频动作 |
| 选中文字后的追问、等待节点内的 Ask / 审批主动作 | 非核心分支动作与新会话高级配置 |

Composer 紧凑态固定保留「追问…」占位、📎 附件与发送/停止；只把 ✏️ 草图
收进聚焦后的展开态。

本交付只裁决并实现壳层的 M1、M2、M11；正文动作、Composer、新会话和
审批卡的进一步精简属于审计 M4–M10，不在本契约内。

## 留 / 藏清单

- 手机 Header 只留两个 44×44 按钮：`会话列表`、`更多功能`；中间显示当前
  session 标题并截断。Header 不横滚，`scrollWidth === clientWidth`。
- overflow 是 `Drawer` 的手机 bottom sheet；一级项依次为：搜索、思维树、
  画布、工作区文件（project 才有）、笔记、导出、模式、模型、主题、任务、
  设置、管理后台（admin 才有）、转桌面版。每个交互项 `min-height: 44px`，
  并带 `data-mobile-target`。
- 导出、模型、主题在 sheet 内展开二级选择；模式是 session 锁定状态，只读。
- 1280×800 继续渲染原桌面 Header。改前实测可见交互项及尺寸为：搜索
  `30×22`、工作区文件 `30×22`、笔记 `30×22`、导出 `49.05×24`、模型
  `127.45×24`、主题 `28×28`、自动化任务 `26.16×21`、设置 `30×22`；
  验收脚本逐项断言。

## M1：slim Header 与 overflow

`Header` 使用统一的 `useIsMobile()` 判定。手机渲染独立 slim 壳，桌面分支
保留原有 DOM 与 class；窄屏桌面 override 只额外出现“回手机版”。

## M2：TreePanel 全屏 sheet

`mobileTreePanelOpen` 是不持久化的 UI 状态。手机关闭时 `TreePanel` 返回
`null`，因此不会覆盖正文或 Composer；从 overflow 打开时先切回 linear，再
渲染 `fixed inset-0` 全屏 dialog。关闭按钮或 Esc 都清状态并保持 linear。
桌面继续使用原右下角悬浮 TreePanel。

`TreePanel` 提升到 `app/page.tsx` 的页面同级，是为了让手机 sheet 脱离
`LinearThreadView` 的 fixed stacking context；否则同为 `z-50` 时 Header 会
截获右上角关闭按钮。

## 转桌面版

- localStorage key：`trellis-desktop-mode`，值 `1` 表示强制桌面。
- `useIsMobile()` 在 media query 为手机时仍会先读该标记；存在则返回
  `false`，所有现有调用方继续只消费 `boolean | null`，无需知道 override。
- overflow 的“转桌面版”写标记后 reload。窄屏桌面 Header 固定显示可见的
  “回手机版”，清标记后 reload。
- localStorage 不可用时安全退化为手机版。
- 这是有意接受的混合态：JS 在 override 下按桌面语义渲染，CSS 的 `max-md:`
  仍按真实窄视口保留 44px 触控尺寸；侧栏位移也只认真实 `>=768px` 视口。

## 二波 TODO

- T-2：把手机卡片上的 CLI resume、重生成、分享卡等非核心动作收入卡片 `…`；
  本波只修壳层与合并语义，不改卡片动作的信息架构。
- F-3：为卡片与选区的两个 `…` 菜单补 `role="menu"`、首项焦点与 Esc 焦点归还。
- N-3：把新会话「历史深度」的点击循环改成可见、可逆的选项控件。

## M11：手机画布落点

手机的线性页不再显示旁路“画布”按钮，唯一入口在 overflow。`Canvas` 每次
由 linear 进入而重新 mount 后，等待首轮 60ms Dagre 测量完成，在 240ms 时
只执行一次 `fitView({ padding: 0.15, duration: 400 })`。桌面不进入该 effect。

## 三波滚动 chrome

手机阅读向下滚动时收起 Header、标题条与紧凑 Composer；内容容器上移的同一
layout frame 内反向补偿 `scrollTop`，因此阅读锚点不跳。顶部恢复带高度至少
`max(var(--safe-top), 24px)`；点击恢复带或被隐藏标题条原占据的顶部阅读区域均
恢复 chrome。桌面不进入该逻辑。

## 后续 TODO

- H-3：把 `useScrollHide` 的模块级隐藏状态收进页面级 state/context，避免未来
  分屏或预览出现多实例互相影响；当前单实例结构不改变。

## 验收

从 worktree 根执行：

```sh
sh scripts/mobile-verify/mobile-slim-shell.sh
```

脚本在 3473 启动带口令的真库备份隔离实例，注入 7 节点 project fixture，
用全新 `mv-mobile-slim-shell` profile 登录并覆盖：iPhone 15 `390×844`、键盘态
`390×480`、桌面对照 `1280×800`。它不发模型请求，trap 会关闭浏览器并终止
隔离实例。

## 合并说明

- `feat/mobile-safe-area`：该分支修改 `Header.tsx` 原桌面 `<header>` 外壳，
  本分支保留那一行原样以便自动合并。合并后需把相同的 `data-safe-area`、
  `--safe-top` 高度与 padding 接到新增 slim Header；`Canvas.tsx` 的 `h-screen`
  → `h-dvh` 与本分支新增的 `data-canvas-surface` / fit effect 应同时保留。
- `feat/mobile-touch-targets`：该分支修改 `TreePanel.tsx` 的“＋ 新树”按钮并加
  `data-mobile-target`，本分支没有改该行；合并时保留其 44px class。本分支的
  overflow 自身已经给所有项目加 `data-mobile-target` 与 44px 下限。
- 两分支对 `LinearThreadView.tsx` 的改动分别在安全区外壳 / Composer、节点动作
  区；本分支只改 import、画布入口和移出 `TreePanel`，预计可自动合并，若冲突
  以“三者都保留”为准。
