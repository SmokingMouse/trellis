# Trellis 侧栏与工作树 · 统一信息架构方案

只读调研，未改仓库任何文件。日期 2026-09-08。

**证据来源**：代码读的是 worktree `chore/ui-audit`（= main 的 6e5e3ce）；真实数据来自生产库只读快照
`sqlite3 ~/.trellis/data.db ".backup /tmp/ia-spec/data.db"`（93 会话 / 720 节点 / 12 项目 / 63 工作区 /
38 herdr 会话）；截图引用体检报告
`.fenjue/archive/fj-ui-audit-7b23/out/shots/`。本轮**没有**起隔离实例（体检报告的 shots 已覆盖本文要引的每一屏，
端口 3493 全程无监听）。

**一句话结论**：侧栏不是「分组太多」，是**同一批东西被三套互不相识的数据通道各画了一遍**，
于是同一个 worktree 出现两次、同一个会话出现两次、38 个会话一次都不出现；而工作树是
**同一份森林被两个组件用两个名字两种结构渲染，且互斥出现**——换个视图它就换个位置换个形状换套动作。

---

## §1 现状盘点

### 1.1 侧栏里到底有哪 14 种行

`components/SessionSidebar.tsx`（1674 行）在一个滚动容器里按固定顺序吐出 7 个顶层组，
外加一个独立滚动的页脚组。逐行拆解（截图 [`d-02`](../../../archive/fj-ui-audit-7b23/out/shots/d-02-home.png)、
[`d-24`](../../../archive/fj-ui-audit-7b23/out/shots/d-24-new-session.png)、手机
[`m-03`](../../../archive/fj-ui-audit-7b23/out/shots/m-03-session-drawer.png)）：

| # | 行 | 它是什么实体 | 数据从哪来 | 点它会怎样 | 形态 |
|---|---|---|---|---|---|
| 1 | ⚓ Herdr › repo | herdr 的 repo（**不是** `projects` 表） | `useHerdrFleet()` 实时 socket（herdr.sock） | 只折叠 | 组 |
| 2 | ⚓ Herdr › worktree | 磁盘目录（与 `workspaces` 表指同一批目录，但不是同一份数据） | 同上 | 只折叠 | 组 |
| 3 | ⚓ Herdr › pane | 一个活着的终端 pane | 同上 | `previewSession(binding.trellisSessionId)`；无绑定则 **disabled** | 叶 |
| 4 | 🔖 稍后再读 › 卡片 | **节点**（`nodes.bookmarked_at`） | `store.bookmarks` | 跳节点（跨会话） | 叶（平表） |
| 5 | 🕘 最近 › 会话 | 会话 | `/api/recent`（独立递归 CTE） | `previewSession` | **既是组又是叶** |
| 6 | 🕘 最近 › 链 ↳ | **链**（root→tip 的一条 lineage） | 同上 | `openNodeInSession(sid, tipId)` → 跳节点 | 叶 |
| 7 | 项目 | `projects` | `/api/sessions` → `listProjectTree()` | 只折叠；＋ = **新建 worktree** | 组 |
| 8 | 工作区 | `workspaces` | 同上 + `/api/workspaces/git-status` | 只折叠；＋ = **在此开会话** | 组 |
| 9 | ✓ 已合并 | workspaces 的一个 git 判据子集 | git-status | 只折叠；🧹 = 批量清理 | 组（默认折叠） |
| 10 | 会话（项目下） | 会话 | `/api/sessions` | `previewSession` | 叶 |
| 11 | Chat | 无 workspace 的 chat 会话集合 | 客户端 `useMemo` 现算 | 只折叠 | 组 |
| 12 | ⏱ 定时任务 › 任务 | **任务**（`tasks`），会话是第一次执行才懒建 | `/api/sessions` 的 `tasks` | 有 home 会话→预览；**没有则整行完全不可点** | 叶 / 死行 |
| 13 | 未归组 | 归不了组的会话 | 客户端现算 | `previewSession` | 组 |
| 14 | 🗄 已归档 | 归档会话 | `/api/sessions?archived=1`（懒加载） | **行本身不可点，只有「恢复」按钮** | 组（**独立 `max-h-48` 滚动区**，不在主滚动容器里） |

即：**9 种实体**（repo / worktree / pane / 节点 / 链 / 会话 / 任务 / 工作区 / 项目）、
**4 种点击语义**（预览会话 / 跳节点 / 只折叠 / 压根不可点）、**3 条数据通道**
（`/api/sessions`、`/api/recent`、herdr 实时 socket）。

### 1.2 逐条列出「不一致」

**I1 · 同一个目录被画两遍，而且两遍的内容互补** —— 这是最伤的一条。
`herdr_sessions` 绑定出来的会话被写成 `sessions.kind='herdr'`，而
`listSessions()` 的 WHERE 是 `kind IN ('user','lark')`（`lib/server/repo.ts:382`），
`listRecentChains()` 同款过滤（`repo.ts:2425`）。真库实测：

- 项目「焚决」有 **12 个 worktree、0 个可见会话**——在项目树里是 12 行空目录；
- 而它们的实际对话全在 ⚓ Herdr 组里（38 个 `kind='herdr'` 会话，`sessions.workspace_id`
  **已经正确指向同一批 `workspaces.id`**）。

同一个 `audit/fj-baseline` 目录，在侧栏上半部是一行「有 2 个 pane 在跑」，在下半部是一行「0 个会话」。
用户说的「有的是工作区，有的是特殊内容」就是这个。

**I2 · 同一个会话被画两遍**。「🕘 最近」是刻意的捷径（`SessionSidebar.tsx:509` 注释写明），
代价是它列的 5 个会话必然在下面的项目树 / Chat 组里再出现一次。
[`d-02`](../../../archive/fj-ui-audit-7b23/out/shots/d-02-home.png) 里「Trellis AS ship-d上线验收」
出现在「最近」和「暂存区」两处。

**I3 · 38 个会话在侧栏完全不可达**。Herdr 组只画**活着的** pane；真库里
`herdr_sessions.alive=0` 有 21 条，对应 21 个会话 / 37 个节点。它们既不在 Herdr 组（pane 死了），
又不在项目树（`kind='herdr'` 被过滤），也不在「最近」（同一过滤）。只能靠全局搜索撞见。

**I4 · 最小可点单元有 5 种并列**：节点（🔖）、链（🕘 的 ↳ 行）、会话（项目树 / Chat / 未归组）、
任务（⏱，且可能不可点）、pane（⚓）。用户扫一眼侧栏没法预判「点下去会发生什么」。

**I5 · 结构有 4 种并列**：三级树（项目→工作区→会话）、**另一棵**三级树（Herdr repo→worktree→pane）、
二级链（最近：会话→链）、平表（Chat 23 行 / 稍后再读 / 定时任务 / 未归组 / 已归档）。
用户说的「有的是树，有的是森林，有的是链」，在侧栏这一层就已经成立了。

**I6 · 结构与需求是倒挂的**（真库统计，这条最值钱）：

| | 会话数 | 多树（森林）会话 | 节点总数 | 最大树数 / 节点数 | 侧栏给它的结构 |
|---|---|---|---|---|---|
| chat 知识会话（无工作区） | 23 | **9（39%）** | **370（占 80%）** | 10 棵 / 124 节点 | **一个 23 行的平表「Chat」** |
| project 工作会话（绑工作区） | 19 | 2（11%） | 91 | 4 棵 / 18 节点 | **完整三级树** |

真正需要层级的是知识会话（`web3学习` 10 棵树 124 节点、`AI产业链` 9 棵 66 节点、
`经济&金融` 8 棵 31 节点、`面试` 5 棵 26 节点），它们被拍平成一列；
基本是单链的工作会话反而享有三级缩进。

**I7 · 层级会自己变形**。`isFlat()`（`SessionSidebar.tsx:1121`）让「暂存区」「主目录」
和「唯一 workspace 且同名」的项目走两级，其余走三级。同一个侧栏里同时存在 2 级和 3 级路径，
且切换是隐式的（新增一个 worktree 就自动变回三级）。设计意图是对的（那一层确实零信息），
但结果是**深度不可预测**。

**I8 · 命名分三派**。带 emoji 的集合名（⚓ Herdr / 🕘 最近 / 🔖 稍后再读 / ⏱ 定时任务 / 🗄 已归档）、
裸中文名词（项目名 / 工作区名 / 未归组 / 已合并）、裸英文（**Chat**）。同一列里三种命名语汇。

**I9 · ＋ 号在三级上是三个意思**：项目行 ＋ = 新建 worktree、工作区行 ＋ = 在此开会话、
⏱ 行 ＋ = 跳到 `/settings/tasks`。图标相同，语义无提示（靠 `title`）。

**I10 · 「已归档」是唯一被踢出主滚动容器的组**（`shrink-0 border-t` + 自带 `max-h-48 overflow-y-auto`），
而且是唯一「行不可点」的会话行——只能按「恢复」。

**I11 · Herdr 不可用时把裸异常串印进导航**（体检 P1-8，
[`d-02`](../../../archive/fj-ui-audit-7b23/out/shots/d-02-home.png) 左上四行 `ENOENT: ENOENT: …herdr.sock`）。

**I12 · 折叠状态有三套记忆策略**：项目 / 工作区 / 五个固定组走 `localStorage`
（`trellis-sidebar-collapsed`）；「还有 N 条链」刻意不持久（`:139` 注释）；
「已归档」「更早」「已隐藏」用组件内 `useState`（刷新即丢）。

**规模实测**（默认全展开，真库数据）：Herdr 约 25 行 + 最近约 26 行 + 项目段约 83 行
（其中 **53 行是工作区行，45 行挂着 0 个会话**）+ Chat 24 行 + 定时任务 3 行 + 未归组 2 行 + 已归档 1 行
≈ **165 行 × 26px ≈ 4300px**，塞在一个约 830px 高的栏里。这就是「熵」的量化形态。

### 1.3 工作树侧：4 个组件在讲同一件事

| 组件 | 何时出现 | 位置 | 标题 | 展示什么 | 独有动作 |
|---|---|---|---|---|---|
| `TreePanel` | **仅线性视图**（`app/page.tsx:155`）；手机由 overflow「思维树」打开全屏 sheet | 桌面右下角悬浮卡（`fixed right-3`，w-72，`max-h min(420px,55vh)`） | **「树」** | 热区 top-5 树行 + **当前树的扁平节点列表**（或点图） + 「更早 · N 棵」 + 「已隐藏 · N 棵」 | 重命名树、标已读/未读、⌘J 过滤跳转、list↔graph、**＋新树** |
| `Outline`（rail） | **仅画布视图**（挂在 `Canvas.tsx:460` 内部） | 桌面左上 `top-96px`，w-60 | **「思维树」** | **整片森林的递归树**（#序号 + 未读点 + 折叠三角） | 只看未读、删除节点（含子树） |
| `Outline`（drawer） | 挂在 `app/page.tsx:174`，`md:hidden` | 手机全屏抽屉 | 「思维树」 | 同上 | — |
| `Canvas` | 视图切换 | 全屏 | — | 同一片森林的 2D 图 | 拖拽、fitView |

**T1 · 同一份数据，两个名字，两种结构，且互斥**。桌面切「🗺 画布」→ 右下角的「树」消失，
左上角冒出一个叫「思维树」的东西，形状从「扁平节点列表」变成「递归森林」，
动作集换掉一半。用户说「一度让我不知道怎么用」，最直接的解释就是这个：
**导航面随视图整块换掉，没有任何连续性**。

**T2 · `Outline` 的 drawer 变体没有任何入口**（可复现）：
`app/page.tsx:174` 挂了 `<Outline variant="drawer" />`，唯一的打开者是
`Header.tsx:353` 的 ⑂ 按钮，它同时被 `className="md:hidden"`（≥768px 隐藏）
和 `!narrowDesktopOverride`（<768px 时为 false，整块不渲染）夹住；
而 `Header.tsx:185` 在 `isMobile` 时**直接 return slim 壳**，那段 DOM 根本不参与渲染。
三个条件互相排斥 ⇒ **这个抽屉永远打不开**。手机 overflow 里那个叫「思维树」的项
（`MobileOverflowMenu.tsx:199`）打开的其实是 **TreePanel**——名字和组件对不上。

**T3 · 动作集不重叠**：重命名树只有 TreePanel 有；删除节点只有 Outline 有；
标已读/未读只有 TreePanel 有；「只看未读」只有 Outline 有；「隐藏这棵树」两边都有；
折叠子树两边共用 `collapsedNodeIds`（这条做对了）。想干某件事得先猜「现在该切到哪个视图」。

**T4 · TreePanel 遮正文 166px**（体检 P1-1，
[`d-05`](../../../archive/fj-ui-audit-7b23/out/shots/d-05-linear-web3.png)、
[`d-13`](../../../archive/fj-ui-audit-7b23/out/shots/d-13-approval-full.png)）。
它是覆盖层不是布局的一部分，内容宽度调到「超宽」只会更糟。

**T5 · 「已隐藏 · N 棵」两处都有，真库 `nodes.hidden_at IS NOT NULL` = 0 行**——
这个功能上线至今一次没被用过，却在两个面板里各占一段代码和一行 UI。

**T6 · 热区是不可见不可控的排名制**。`HOT_TREE_LIMIT = 5`（`lib/tree-panel.ts:16`），
热度 = `max(子树 createdAt/readAt, 树根 lastVisitedAt)`。`web3学习` 有 10 棵树 ⇒
**默认有 5 棵藏在「更早」折叠里**，而用户无从知道排序依据。

**T7 · 同一个面板两种记忆策略**：展开/收起是组件内 `useState(false)`（`TreePanel.tsx:85`），
切会话、刷新全部重置；而 list/graph 视图偏好走 store 持久化。

**T8 · 三个「新建」动词同屏**，靠 tooltip 互相解释：侧栏「＋ 新会话」（tooltip 写「与『🧹 新话题』不同」）、
TreePanel「＋ 新树」（tooltip 写「等价 /clear」）、Composer 的「🧹 新话题」。

**T9 · 链在阅读面是隐式的**。线性视图一次只显示一条 lineage，但**没有任何常驻控件**告诉你
「你在哪条链上、这棵树还有几条链」。想换链要么绕回侧栏的「🕘 最近」，要么在 TreePanel 里点节点。
真库 20 个会话有分叉、共 57 个分叉点——这不是边缘场景。

**T10 · 画布在真实数据量下两端都失效**（体检 P1-2 / P1-3：桌面 124 节点会话视口内只有 6 张卡、
手机 fitView 后字全糊，[`d-04`](../../../archive/fj-ui-audit-7b23/out/shots/d-04-linear-big.png)、
[`m-09`](../../../archive/fj-ui-audit-7b23/out/shots/m-09-canvas.png)）。
它却是 Outline 的唯一宿主——**要看递归森林，必须先进一个看不清的画布**。

---

## §2 概念模型

### 2.1 唯一层级（五层，不改任何表）

| 层 | 一句话定义 | 表 | 在侧栏的唯一位置 |
|---|---|---|---|
| **项目** | 一个代码仓（或两个伪仓：暂存区 / 主目录） | `projects` | 顶层组行 |
| **工作区** | 项目在磁盘上的一份 checkout（main / worktree / plain） | `workspaces` | 项目下一级；**零信息时按 `isFlat` 省略**（现有规则保留） |
| **会话** | 一次对话容器，绑一个工作区 | `sessions` | 工作区下一级；**侧栏的叶子，到此为止** |
| **树** | 会话内一个 `parent_id IS NULL` 的根及其子树 = 一个独立话题 | `nodes` | **不进侧栏**，进会话内面板 |
| **节点** | 一轮问答 | `nodes` | **不进侧栏**，进会话内面板 |

**唯一的最小可点单元 = 会话**（在侧栏）/ **节点**（在会话内面板）。
这条线画在「会话」上，是因为它是 URL 的单位（`/?session=&node=`）、tab 的单位、
和「切换上下文」的心理单位。侧栏管「去哪个会话」，会话内面板管「去这个会话的哪里」。

**链不是一层**。链 = 树里从根到某个叶子的一条路径，是**线性视图的产物**（它一次只能画一条）。
概念上它叫「阅读位置」。它该出现在两个地方，都不是侧栏：
① 会话行点击时的**默认落点**（`openNodeInSession` 已经实现，即「回到上次读到的地方」）；
② 会话内面板里当前树的「其它分支」列表。

### 2.2 横切集合 → 筛选 / 视图，不再并列成组

| 现在的组 | 它其实是 | 改成 |
|---|---|---|
| 🕘 最近 | 同一批会话的**另一种排序** | 侧栏顶部 `按项目 ▏按时间` 分段器。**同一个列表两种排布，永不并存** |
| 🗄 已归档 | 同一批会话的**一个筛选位** | 工具条上的 `☐ 含已归档` 复选；命中行灰显并带「归档」chip |
| ⚓ Herdr | 会话的**来源**（`origin='herdr'`） | 并入项目树；行右侧一枚 `⚓ 活` chip + pane 状态点（数据已经能对上：`sessions.workspace_id` 有值） |
| ⏱ 定时任务 | 会话的**来源**（`kind='task'`） | 并入项目树，行右侧 `⏱` chip；任务本体的 CRUD 留在 `/settings/tasks` |
| 💬 Lark | 会话的**来源**（`kind='lark'`） | 同上，`💬` chip（现在它已经混在主列表里，只是没有 chip） |
| 🔖 稍后再读 | **节点**级集合 | 移出侧栏 → 已有的 `BookmarksDrawer`（真库 0 条，本来就没内容） |
| 未归组 | 归不了组的会话 | 并入「暂存区」伪项目（它本来就是「没有仓库的会话」的家） |
| ✓ 已合并 | 工作区的一个 git 状态 | 保留（这是真的按状态分类，不是按实体分类），但只在展开工作区层时出现 |

结果：顶层从 **8 组 / 14 种行** 收敛到 **1 棵树 + 1 条工具条 / 4 种行**（项目 · 工作区 · 会话 · 已合并组）。

### 2.3 会话内结构在概念模型里怎么叫

| 形态 | 叫法 | 用户什么时候需要它 |
|---|---|---|
| 一棵树 | **话题** | 默认；单树会话（真库 31/42）里它就等于会话本身，**不该有任何额外 UI** |
| 一片森林 | **这个会话的话题列表** | 知识会话（`web3学习` 10 个话题）：在一个上下文里横跳话题。面板顶部一行一个话题 |
| 一条链 | **阅读位置** | 分叉会话（真库 20 个 / 57 个分叉点）：「我在哪条线上、还有哪几条」。面板里当前话题下的高亮路径 + 「其它分支 N 条」 |

对应的动线只有三条：**开新话题** / **在话题间跳** / **在一个话题里换分支**。
现在这三条被摊在 TreePanel + Outline + Canvas + 侧栏「最近」四个面上。

---

## §3 候选方案

三个方案共享 §2 的概念模型，分歧在**把结构放在哪**。三者都不改数据模型，都能分波上线。

### 方案 A · 一棵树 + 一条工具条（收敛派）

**侧栏结构**（真实数据，`按项目` 排布，默认态）：

```
┌ ＋ 新会话                                    ⟨ ┐
│ 按项目 ▏按时间          来源: 全部 ▾   ☐ 含归档 │   ← 新增工具条（唯一的横切控制）
├──────────────────────────────────────────────┤
│ ▾ trellis                              ●3 ⚓2 │
│   ▾ trellis            main   ●2            │
│       现在 trellis 使用体验基本没啥问题了…      │
│       对于 project 模式，怎么clear session…    │
│   ▸ chore-ui-audit     chore/ui-audit  ⚓1 生成中│
│   ▸ feat-herdr-bridge  feat/herdr-bridge  ●1 │
│   ▸ 已合并 (9)                            🧹 │
│ ▾ 焚决                                 ⚓5   │
│   ▸ audit/fj-baseline  ●2 ⚓1  🙋 等你回答     │
│   ▸ audit/fj-verdict   ●2                    │
│   ▸ 已合并 (7)                            🧹 │
│ ▾ .claude                              ●4 ⚓3│
│   ▾ .claude            master  ●4            │
│       harness                    4 话题       │
│       南山桌游店推荐                           │
│   ▸ c2-slim            audit/c2-slim  ⚓1     │
│ ▾ 暂存区（无仓库）                      ●11  │
│     Trellis AS ship-d上线验收                 │
│     话说是不是我的 cpa 协议兼容问题…    2 话题  │
│     把本地的happyclaw更新到最新               │
│     …                                        │
│ ▾ 速记（chat · 无工作区）               ●23  │
│     web3学习                     10 话题 ●3  │
│     AI产业链                      9 话题      │
│     经济&金融                     8 话题      │
│     面试                          5 话题      │
│     房屋交易 · 期权学习 · 台积电 …            │
└──────────────────────────────────────────────┘
```

- 「按时间」排布 = **同一批会话拍平成一列**、按 `updatedAt` 降序、每行右侧带项目名做前缀标签。
  「🕘 最近」组因此退役——它的价值（一眼看到最近在动的东西）由排布模式承担，而不是靠再画一遍。
- 「最近」里的**链行**搬进会话内面板（见下），侧栏点会话仍然落到上次读到的位置（现有行为不变）。
- Herdr pane 状态 overlay 到会话行（`⚓` chip + 状态点），Herdr 组退役。
- Chat 会话归进一个显式的伪项目「速记（chat · 无工作区）」，与「暂存区」并列——两个伪项目，语义清楚。
- 会话行右侧统一三段：`来源 chip`（⚓ / ⏱ / 💬 / CC / CX）· `话题数`（>1 才显示）· `状态`（🙋 / 生成中 / ● 未读）。

**会话内工作树**：`TreePanel` 与 `Outline` 合并为**一个右侧「结构」面板**，
**推挤（push）而非覆盖**——默认收起为一条 36px 竖条（竖排写「结构」+ 未读数），
展开 280px 时内容列压窄。内容 = 一棵递归森林（Outline 的结构）+ 当前话题自动展开、
其余话题折叠成一行带计数（TreePanel 的分组），当前链高亮，
分叉点下方一行「其它分支 2 条 ▸」。顶部一行：`话题数 · ＋新话题 · ⌕过滤(⌘J) · 🗺地图`。
画布从「视图切换」降级为面板里的「🗺 地图」覆盖层（选中节点即关闭并落回线性）。

**桌面 / 手机差异**：手机侧栏 = 现有 drawer（`mobile-shell.md` 裁决不动），
drawer 内同样有排布分段器；会话内面板复用已有的 **TreePanel 全屏 sheet**（M2 裁决不动），
入口仍在 overflow，名字统一为「结构」。删掉不可达的 Outline drawer。

**动到**：`SessionSidebar.tsx`、`lib/server/repo.ts`（`listSessions` / `listRecentChains` 放开 kind）、
`HerdrSidebarGroup.tsx`（退化为状态 overlay）、`TreePanel.tsx` + `Outline.tsx`（合并）、
`LinearThreadView.tsx`（push 布局）、`app/page.tsx`、`Canvas.tsx`（入口语义）。

**迁移成本**：中。**风险**：
① push 布局要重做 TreePanel 现在的 page 级提升（`mobile-shell.md` 记录了它绕 stacking context 的原因）；
② 「最近链」是真捷径，搬进会话内面板后「跨会话回到上次问到哪」会多一跳——这是 §5 第 1 条要拍板的。

### 方案 B · 待办段 + 项目段（分层派）

**侧栏结构**：上下两段，中间一条硬分隔。

```
┌ ＋ 新会话                                    ⟨ ┐
│ 需要我 (4)                            全部展开 │  ← 段一：定高 max 8 行，不可滚过界
│   🙋 fj-baseline 代码审查      焚决/fj-baseline│
│   ⚡ Trellis mobile experience  trellis/trellis│
│   ● harness                      .claude       │
│   ⏱ 每日简报 · 09:00 失败                     │
├──────────────────────────────────────────────┤
│ 项目                          来源▾  ☐含归档  │  ← 段二：唯一的树，同方案 A
│ ▾ trellis › trellis › …                       │
│ ▾ 焚决 › audit/fj-baseline › …                │
│ …                                             │
└──────────────────────────────────────────────┘
```

- 段一「需要我」= 所有 `waiting / streaming / unread / 任务失败` 的会话，跨来源合并，一行一个。
  它替掉 Herdr 组 + 最近组 + 定时任务组的状态职能。
- 段二 = 方案 A 的那棵树，但**段一出现过的会话在段二里灰显**（避免 I2 复发）。
- 会话内工作树：与 A 相同的合并面板，但停靠在**左侧栏下段**（侧栏一栏到底，
  上面是跨会话导航、下面是会话内结构），正文完全不被侵占。

**桌面 / 手机差异**：手机 drawer 内同样两段；会话内结构在手机上仍走全屏 sheet（不可能塞进 drawer）。

**动到**：同 A，另加一个 `AttentionBand` 新组件；会话内面板改挂侧栏而非右栏。

**迁移成本**：中（比 A 多一个组件，少一次 push 布局改造）。**风险**：
① 段一在忙的时候（真库有 18 个活 pane）会把段二挤扁，必须定高 + 内部滚动，这本身又是一个新的滚动容器；
② 「灰显去重」是一条需要用户学的规则——为了消灭重复而引入一条新规则，方向上是可疑的；
③ 会话内结构挂左栏后，与线性正文距离最远，跳节点时眼睛要横穿整屏。

### 方案 C · 侧栏只管会话，工作树上移为二级导航（激进派）

**侧栏结构**：彻底扁平，一列会话，顶部一个项目筛选下拉。

```
┌ ＋ 新会话        项目: 全部 ▾   ⌕            ⟨ ┐
│ web3学习                          速记  10话题 │
│ Trellis mobile experience…   trellis  ⚡生成中 │
│ fj-baseline 代码审查         焚决    🙋       │
│ AI产业链                          速记  9话题  │
│ harness                        .claude 4话题  │
│ 经济&金融                         速记  8话题  │
│ …（按活动时间，一页 30 行）                    │
└──────────────────────────────────────────────┘
```

- 工作区 / 分支 / 脏文件 / worktree 回收全部搬到 `/settings/workspaces`（那个 tab 已经存在）。
- 会话内的树**提到顶部**：SessionTabs 下面加一条「话题条」（横向 chip，一个话题一枚，带状态角标），
  点 chip 换话题；节点级定位靠 ⌘J 过滤 + 右侧可推挤的大纲。画布降级为地图。

**桌面 / 手机差异**：手机上「话题条」会吃掉首屏 40px，与 `mobile-shell.md`
「手机首屏只留会话 drawer + 标题 + overflow」的裁决冲突 ⇒ **手机必须退化成方案 A 的形态**（overflow 里的结构 sheet）。
这是 C 的结构性减分项：桌面与手机的会话内导航不同源。

**动到**：`SessionSidebar.tsx`（重写）、新 `TopicBar` 组件、`SettingsWorkspaces`（承接工作区管理）、
`TreePanel`/`Outline`/`Canvas`。

**迁移成本**：大。**风险**：
① 丢掉工作区层的常驻可见性——而这个用户是真在用它（63 个工作区、git 脏文件角标、批量清理已合并、
   行内建 worktree），把它塞进设置页等于把日常动作降级；
② 桌面/手机会话内导航不同源，长期维护两套。

### 三案对照

| | A · 一棵树+工具条 | B · 待办段+项目段 | C · 扁平列+顶部话题条 |
|---|---|---|---|
| 顶层区域数 | **1**（+工具条） | 2 | 1 |
| 最小单元数 | 1（会话） | 1（会话） | 1（会话） |
| 消灭 I1/I2/I3 | ✅ | ✅（靠灰显规则） | ✅ |
| 修 I6（结构倒挂） | ✅ 知识会话进伪项目 + 话题数上行 | ✅ 同 | ✅ 话题数上行，但丢工作区层 |
| 「谁在等我」 | 靠行内状态 + 按时间排布 | **专门一段，最强** | 靠排序 |
| 工作区管理常驻 | ✅ | ✅ | ❌ 搬去设置 |
| 桌面/手机同源 | ✅ | ✅ | ❌ |
| 正文被遮 | ✅ 修（push） | ✅ 修（面板挪左栏） | ✅ 修 |
| 成本 | 中 | 中 | 大 |

---

## §4 推荐

**推荐方案 A**，理由三条：

1. **它是唯一一个「只做减法」的方案**。用户的原话是「影响人大脑的熵」——熵来自区域数和规则数，
   不来自功能少。A 把 8 个顶层组换成 1 棵树 + 1 条工具条，且没有引入任何新规则；
   B 为了消灭重复引入「段一出现过的在段二灰显」这条新规则，是用规则换规则。
2. **B 的核心收益在 A 里几乎免费**。「谁在等我」在 A 的「按时间」排布下天然浮到顶部，
   而行内状态染色（`bg-accent-muted` + 左侧 accent 条 + 「等你回答」文字）**现在就已经很响**
   （`SidebarRow` 的 `indicatorStatus` 分支）。真要一个常驻待办条，体检方向 3 的
   `PendingBar`（挂 Header 下方，全宽）比在侧栏里再切一段更合适——那是跨会话的全局提醒，不该占侧栏纵向预算。
3. **C 拿走的东西是用户在用的**。63 个工作区、45 个空工作区行确实是噪音，
   但解法是「空工作区行折叠进『▸ 其它 N 个工作区』」（A 里可做），不是把整层搬去设置页。

审美类判断（自行决定，依据写在这里）：

- **会话行右侧统一「来源 chip · 话题数 · 状态」三段**，而不是现在的「tag / git 角标 / badge / 操作按钮」
  四种在 hover 时互相顶替。依据：`GroupRow` 现在用 `group-hover:hidden` 让 badge 给操作让位，
  导致同一行在 hover 前后信息量不同，扫视时会「闪」。
- **emoji 只用于状态（🙋 ⚡ ●），不用于分类**。现在 ⚓🕘🔖⏱🗄 五个分类 emoji 是把「集合」
  伪装成「实体」的视觉信号，分类消失后它们自然一起消失。
- **保留** 体检 §5 的 5 / 6 两条（空状态文案「还没有 X + 下一步」、降级说明卡），
  Herdr 不可用时用降级卡替掉裸 ENOENT，且降级卡只在「按来源筛选 = Herdr」时才显眼。
- **保留**折叠状态的 localStorage 持久化，并把「更早 / 已归档 / 已隐藏」三处 `useState` 一并收进去（I12）。

### 分波实施（每波可独立上线、可回退）

**波 1 · 统一最小单元（小，纯删 + 一个 SQL 谓词）**
1. `listSessions()` / `listRecentChains()` 的 `kind IN ('user','lark')` 放开到含 `'herdr'`、`'task'`
   （`repo.ts:382`、`:2425`）；会话行加 `origin/kind` chip。→ 直接消灭 I1 的空目录和 I3 的 38 个幽灵会话。
2. 删三个顶层组：🔖 稍后再读（真库 0 条，能力搬 `BookmarksDrawer`）、⏱ 定时任务（变 chip）、未归组（并入暂存区）。
3. 删不可达的 `<Outline variant="drawer">`（`app/page.tsx:174`）与 `Header.tsx:353` 那个永不渲染的 ⑂ 按钮（T2）。
4. 删两处「已隐藏 · N 棵」（真库 0 行，T5）。
5. Herdr 组的裸 ENOENT 换成降级说明卡（体检 P1-8）。
   **回退**：全是删除 + 一个谓词，`git revert` 即可。**判据**：侧栏顶层组 8 → 4；焚决项目下的 worktree 行不再是 0 会话。

**波 2 · 排布切换（中）**
6. 侧栏工具条：`按项目 ▏按时间` + `来源 ▾` + `☐ 含归档`。「按时间」= 拍平列表。
7. 「🕘 最近」组退役；其链行能力搬进会话内面板顶部的「其它分支」。
8. Herdr 组退役，pane 状态 overlay 到会话行（`useHerdrFleet` 只留 status map）。
9. Chat 会话归入显式伪项目「速记」；空工作区折叠成「▸ 其它 N 个工作区」。
   **回退**：工具条默认值设为「按项目」+ 保留旧组代码一个版本。**判据**：顶层区域 = 1 棵树；侧栏总行数从 ~165 降到 ~60。

**波 3 · 会话内面板合并（中）**
10. `TreePanel` + `Outline` → 单一「结构」面板，右侧 **push**，默认 36px 竖条。
11. 面板内：递归森林 + 当前话题展开 + 当前链高亮 + 「其它分支 N 条」。
12. 手机复用现有全屏 sheet，统一命名为「结构」。
    **回退**：新面板加 feature flag，旧两个组件保留一个版本。**判据**：正文与面板 0 重叠（体检 P1-1 归零）；
    「树 / 思维树」两个名字只剩一个。

**波 4 · 画布地图化（可选，看 §5 第 4 条拍板）**
13. 画布从「视图切换」改为面板里的「🗺 地图」覆盖层，进入必 fitView，选中即关闭落回线性。

---

## §5 待用户拍板（5 条，每条附我的倾向）

1. **「🕘 最近」的链行要不要保留在侧栏？**
   它是目前唯一能一步跨会话回到「上次问到哪」的入口（`openNodeInSession`），代价是侧栏里 5 个会话必然重复一遍。
   **我倾向：拿掉侧栏的链行**——会话行点击本来就落到上次读到的位置，链的选择放进会话内面板。
   但如果你日常真的靠那三条 ↳ 行在多个会话间跳，那它是有意设计而非噪音，那就保留「最近」并把项目树里的重复行去掉（反向去重）。

2. **⚓ Herdr 并进项目树，还是保留独立一组？**
   数据上已经能对上（`sessions.workspace_id` 有值），并进去就能同时修掉「同一个 worktree 画两遍」和「21 个死 pane 会话不可达」。
   **我倾向：并入**，Herdr 只保留一个「来源筛选」和行内的活/死状态点。
   反方理由是：你可能就是把侧栏顶部当「舰队看板」在用，那它该留独立一段（= 方案 B 的段一）。

3. **会话内「结构」面板停哪？**
   右侧 push（方案 A）/ 左侧栏下段（方案 B）。
   **我倾向：右侧 push**——它离正文近、和线性阅读方向一致，且能彻底修掉 166px 遮挡；
   代价是展开时内容列变窄（1440 宽、侧栏 210px 时，可用宽从约 1230px 降到约 950px，
   仍高于「宽」档现在实测的 958px 阅读列——即**默认档几乎不受影响，只有「超宽」档会真的变窄**）。

4. **画布还算不算「第二种阅读视图」？**（与体检报告 §待拍板 1 同一条，但这里多一个约束：Outline 现在寄生在画布里）
   **我倾向：降级为地图覆盖层**。真库最大会话 124 节点 / 10 棵树，画布两端都读不了；
   而把 Outline 从画布里救出来是波 3 的前提。若你要保「画布式工作台」的产品身份，那波 3 的面板合并要改成
   「画布内的 Outline 与线性里的面板共用同一个组件」，成本 +1 波。

5. **两个伪项目要不要显式改名？**
   现在叫「暂存区」（随机词表命名的沙箱目录，如 `sunny-finch-79`）和「主目录」，而 23 个 chat 会话连伪项目都没有，直接躺在一个叫「Chat」的平表里。
   **我倾向：三者归成两个显式伪项目**——「暂存区（临时目录）」和「速记（无工作区）」，
   命名一律中文、一律「名词 + 括号说明」。反方：你可能希望 chat 会话继续贴顶，那就把「速记」固定排在第一位而不是按活动时间排。

---

## 附 · 本文所有实测数字的复现命令

```sh
mkdir -p /tmp/ia-spec && sqlite3 ~/.trellis/data.db ".backup '/tmp/ia-spec/data.db'"

# 森林 vs 链（I6 那张表）
sqlite3 -header /tmp/ia-spec/data.db "
with r as (select s.id, s.context_mode m, s.workspace_id wid, count(*) roots,
  (select count(*) from nodes n2 where n2.session_id=s.id) nodes
  from sessions s join nodes n on n.session_id=s.id and n.parent_id is null
  where s.archived=0 and s.kind in ('user','lark') group by s.id)
select case when wid is null and m='chat' then 'chat/知识' else 'project/工作' end grp,
  count(*) sessions, sum(case when roots>1 then 1 else 0 end) multi_tree,
  sum(nodes) nodes, max(roots) max_roots, max(nodes) max_nodes from r group by 1;"

# 幽灵会话（I3）
sqlite3 -header /tmp/ia-spec/data.db "
select h.alive, count(distinct s.id) sess,
  sum((select count(*) from nodes n where n.session_id=s.id)) nodes
from herdr_sessions h join sessions s on s.id=h.session_id group by 1;"

# 从未使用的功能（T5 / 稍后再读）
sqlite3 /tmp/ia-spec/data.db "select
  (select count(*) from nodes where hidden_at is not null) hidden_trees,
  (select count(*) from nodes where bookmarked_at is not null) bookmarks;"

# 空工作区行（§1.2 规模实测）
sqlite3 -header /tmp/ia-spec/data.db "
with vis as (select * from sessions where archived=0 and kind in ('user','lark'))
select p.name, count(distinct w.id) ws_total,
  sum(case when (select count(*) from vis v where v.workspace_id=w.id)>0 then 1 else 0 end) ws_with_sess
from projects p left join workspaces w on w.project_id=p.id group by p.id order by ws_total desc;"
```
