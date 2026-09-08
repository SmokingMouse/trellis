目标：侧栏统一信息架构 **波 2 · 排布切换**，按已拍板的方案 A（`progress/sidebar-tree-ia.md` §2 概念模型、§3 方案 A、§4「分波实施 · 波 2」第 6–9 条、「审美类判断」；静态稿 `.fenjue/archive/fj-sidebar-tree-ia-4784/out/mockups/a-sidebar-desktop.html`、`a-mobile-drawer.html`）。波 1 已合 main（PR feat/sidebar-wave1：会话来源统一 + 三组删除），本 worktree 从合并后的 main 拉出。用户已同意方案与五条倾向：去掉侧栏链行、Herdr 并入项目树、伪项目显式命名。

## 本波范围（§4 波 2 的四条）

6. **侧栏工具条**：`按项目 ▏按时间` 分段器 + `来源 ▾`（全部 / 网页 / Herdr / 任务 / 飞书）+ `☐ 含已归档`。「按时间」= 同一批会话拍平按最后活动排序（会话行仍带项目/工作区小字与来源 chip）；两种排布**永不并存**；选择持久化到 localStorage（沿用现有折叠态持久化机制，顺手把「更早 / 已归档 / 已隐藏」几处 useState 收进同一持久化，I12）。「含已归档」勾上时归档行灰显并带「归档」chip；默认不勾。
7. **「🕘 最近」组退役**：其唯一不可替代能力「一步回到上次问到哪」由会话行点击默认落点承担（`openNodeInSession` 已实现，确认并补测试）；链行（↳）能力搬进会话内面板顶部「其它分支」——本波只需保证会话内面板已有入口能到达其它分支（TreePanel 现有能力即可），不做面板合并（波 3）。
8. **Herdr 组退役**：Herdr 会话已在项目树里（波 1），pane 活/死状态改为会话行内的状态点 + `⚓` chip；`useHerdrFleet` 只保留 status map；Herdr 不可用时的降级说明改为「来源筛选 = Herdr」时在列表顶部显示一张降级卡（体检 §5 保留项），其它时候不占位。仓库/worktree 级信息（分支、是否已合并）保留在工作区行（波 1 后结构不变）。
9. **伪项目显式命名与空工作区折叠**：Chat 会话归入显式伪项目「速记」；「暂存区」「主目录」两个伪项目在侧栏用清晰名字与说明 tooltip（不改 projects 表的 id，只改展示层命名与图标）；项目下 0 会话的工作区折叠成一行「▸ 其它 N 个工作区」，展开后可见。

**不做**：会话内面板合并、画布、待办条；不改手机首屏结构（`progress/mobile-shell.md`），手机会话抽屉复用同一套列表与工具条（紧凑排版见 `a-mobile-drawer.html`）。

## 验收判据（写进 result 并给证据）

- 生产库快照隔离实例（端口 3497，`.backup` + `next start`，不碰 3088）截图：桌面 1440×900 按项目 / 按时间 / 来源=Herdr / 含归档 四态，手机 390×844 会话抽屉两态；侧栏顶层区域 = 1 棵树 + 1 条工具条（Herdr 组、最近组消失）；侧栏总行数前后对比（方案预期 ~165 → ~60，实际数字写进 result，用 DOM 计数）。
- 「回到上次读到的地方」：点会话行落到上次 node 的行为有测试或脚本断言。
- `bunx tsc --noEmit`、`bun test` 全绿，新逻辑（排布切换、来源筛选、归档筛选、空工作区折叠、伪项目命名）有单测。
- 11 条手机脚本统一前缀独占跑绿（前缀 `env -i HOME=/Users/smokingmouse PATH="$PATH" TRELLIS_LARK=off TRELLIS_SCHEDULER=off TRELLIS_HOOKS=off TRELLIS_HERDR=off TRELLIS_VERIFY_SOURCE_DB=/Users/smokingmouse/.trellis/data.db`）；脚本里针对「最近」组、Herdr 组的断言按新结构改并逐条写明理由；跑完 3471–3480 与 3497 无监听、锁已清。
- 回退：工具条默认「按项目」+ 用 feature flag `NEXT_PUBLIC_TRELLIS_SIDEBAR_V2`（或同类现有机制）保留旧组代码一个版本，flag off 时恢复波 1 后的旧结构；result 写明开关。
- **不要发 partial result**，中间只用 progress；全部绿后发唯一一封 result（done）。提交到本 worktree 分支 `feat/sidebar-wave2`，工作树干净；不 push、不 PR、不部署。
