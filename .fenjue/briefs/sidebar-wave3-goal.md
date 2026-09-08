目标：侧栏统一信息架构 **波 3 · 会话内面板合并**，按已拍板的方案 A（`progress/sidebar-tree-ia.md` §2.3「会话内结构」、§3 方案 A、§4「分波实施 · 波 3」第 10–12 条；静态稿 `.fenjue/archive/fj-sidebar-tree-ia-4784/out/mockups/a-session-tree-collapsed.html`、`a-session-tree-expanded.html`）。用户已同意：结构面板放右侧 push；画布降级为地图（波 4 做，本波只需不阻碍）。波 1、波 2 已在 main（含 flag `NEXT_PUBLIC_TRELLIS_SIDEBAR_V2`）。本 worktree 从合并后的 main 拉出。

## 本波范围（§4 波 3 的三条）

10. **TreePanel + Outline → 单一「结构」面板**：右侧 **push**（推挤内容列，不是覆盖），默认收起为一条 36px 竖条（带话题数/分支数小徽标），展开时内容列被压窄；彻底消灭体检 P1-1（面板遮正文 166px）。展开/收起状态与宽度 localStorage 持久化。现有 TreePanel 被提升到 page 级是为绕 stacking context（见 `progress/mobile-shell.md`），改 push 布局要重做这层，注意 Composer、抽屉、toast 的 z 序与 Composer 右侧三键不被遮（体检 P1-9 顺手不回归即可，不要求修）。
11. **面板内容**：递归森林（这个会话的话题列表，一行一个话题，单树会话不额外占位）+ 当前话题展开 + 当前链（阅读位置）高亮 + 「其它分支 N 条」（波 2 退役的侧栏链行能力在这里落地：点分支落到该分支叶子）。名字统一叫「结构」，「树 / 思维树」两个旧名只留一个入口文案。键盘：面板可聚焦、方向键移动、Enter 跳转、Esc 收起。
12. **手机**：复用现有全屏 sheet（`progress/mobile-shell.md` 裁决），命名统一为「结构」，内容与桌面同源组件。

**画布**：本波不改画布的阅读语义（波 4 做地图化），但 Outline 从画布里解出来后，画布视图仍要能打开同一个「结构」面板（同一组件，不再各画一套）。

**不做**：待办层、Composer 动线、设置后台、视觉重画。

## 验收判据（写进 result 并给证据）

- 生产库快照隔离实例（端口 3500，`.backup` + `next start`，不碰 3088）截图：桌面 1440×900 线性视图收起态 / 展开态 / 分叉会话（≥3 分支）展开态 / 画布视图打开结构面板；手机 390×844 结构 sheet。用 DOM 实测证明**正文列与面板零重叠**（体检 P1-1 归零：给出 `.md-body` 与面板 rect 的数字）。
- `bunx tsc --noEmit`、`bun test` 全绿；新逻辑（森林/链/其它分支计算、持久化、键盘）有单测。
- 现有手机脚本统一前缀独占跑绿（前缀 `env -i HOME=/Users/smokingmouse PATH="$PATH" TRELLIS_LARK=off TRELLIS_SCHEDULER=off TRELLIS_HOOKS=off TRELLIS_HERDR=off TRELLIS_VERIFY_SOURCE_DB=/Users/smokingmouse/.trellis/data.db`）；脚本里针对旧 TreePanel / Outline / 「思维树」文案的断言按新结构改并逐条写明理由；跑完 3471–3480 与 3500 无监听、锁已清。
- 回退：新面板走 feature flag（沿用 `NEXT_PUBLIC_TRELLIS_SIDEBAR_V2` 或新增 `NEXT_PUBLIC_TRELLIS_STRUCTURE_PANEL`），off 时旧 TreePanel/Outline 保留一个版本；result 写明开关。
- **不发 partial result**，中间只用 progress；全部绿后发唯一一封 result（done）。提交到本 worktree 分支 `feat/sidebar-wave3`，工作树干净；不 push、不 PR、不部署。
