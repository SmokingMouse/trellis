目标：针对用户点名的两大痛点——左侧目录混乱、工作树展示混乱——出一份统一的信息架构方案，附自包含 HTML 静态稿，供用户拍板。只读，不改代码。

## 用户原话（唯一使用者，自用工具；务实，不要过度设计）

> 1. 左侧目录太混乱了，非常影响人大脑的熵，结构非常不一致，有的是工作区，有的是特殊内容，最小单元有的是树，有的是森林，有的是链，也非常的不一致
> 2. 这个工作树的展示也非常不合理，或者说特别混乱吧，就一度让我不知道怎么用。

## 输入（先读）

- 体检报告 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-ui-audit-7b23/out/ui-audit.md` 的 §1.2、§2、§3、§5、§6（方向 1「导航面收敛」、方向 2「画布降级为地图」）与 `shots/`（侧栏见 d-02、d-24、m-03；树面板见 d-05、d-13；画布见 d-04、m-09）。
- 规格与历史裁决：`progress/recent-chains.md`（最近链）、`progress/console-ia-spec.md`、`progress/mobile-shell.md`（手机壳裁决：会话 drawer、全屏 sheet）、`progress/project-workspace-layer.md`（项目/工作区层级）、`progress/decisions.md` 里与侧栏/树/画布相关的条目。
- 代码：`components/SessionSidebar.tsx`（约 1500 行，侧栏全部分组逻辑）、`components/HerdrSidebarGroup.tsx`、`components/SessionTabs.tsx`、`components/TreePanel.tsx`、`components/Outline.tsx`、`components/Canvas.tsx`、`components/LinearThreadView.tsx`、`app/page.tsx`；数据模型看 `lib/server/repo.ts` 与相关 schema/migration（projects / workspaces / sessions / trees / nodes / 最近链 / 归档 / Herdr repo·worktree 分别是什么实体）。
- 真实数据：生产库快照（`sqlite3 ~/.trellis/data.db ".backup /tmp/ia-spec/data.db"` 后只读查询），用真实的项目/工作区/会话标题画稿（不写 token、路径里去用户名）。需要看真实界面就按体检报告附录的隔离实例起法（端口 3493，结束杀掉），不碰 3088。

## 交付物（全部放 out/）

1. `ia-spec.md`（中文）：
   - **§1 现状盘点**：侧栏里出现的每一种条目类型（项目、工作区、会话、树、链、Herdr repo / worktree、最近、暂存区、已归档、已合并工作区、书签……）各对应什么实体、来自哪张表 / 哪个 API、点击落到哪、为什么用户会感到「最小单元不一致」——把不一致逐条列出配截图。工作树侧：TreePanel / Outline / Canvas / SessionTabs 各展示什么、何时出现、和线性视图什么关系、用户「不知道怎么用」的具体原因（入口、语义、遮挡、状态）。
   - **§2 概念模型**：提出**一个**统一层级（例如 项目 → 工作区 → 会话 → 树 → 节点），每层一句定义、唯一的「最小可点单元」是什么、每层允许出现在侧栏的什么位置；「最近」「归档」「Herdr」「书签」这类横切集合改成筛选 / 视图而不是并列分组的话怎么呈现；会话内结构（一棵树 / 一片森林 / 一条链）在概念模型里各叫什么、用户在什么动线里需要它们。
   - **§3 候选方案 A / B / C**（两到三个）：每个给侧栏结构（文字树，用真实数据）+ 会话内工作树的展示方式（位置、默认态、展开态、与画布的关系）+ 桌面 / 手机差异 + 动到的组件 + 迁移成本（小 / 中 / 大）+ 风险；方案之间要有真实取舍，不要一个真方案两个陪跑。
   - **§4 推荐**与理由；可分波实施的顺序（每波可独立上线、可回退）。
   - **§5 待用户拍板** ≤5 条，每条给出你的倾向。
2. `mockups/*.html`：自包含单文件 HTML 静态稿（内联 CSS / SVG，不引外链，深色主题贴近现有 token；可用一小段内联 JS 做展开 / 收起切换），至少：每个方案一张桌面侧栏（1440 宽）、推荐方案的会话内工作树折叠态与展开态各一张、推荐方案的手机会话抽屉一张。稿里的标题用真实会话数据。
3. `out/result.md`：产物清单与查看方式。不改仓库任何文件；审美类问题自己判断并写明依据，不发 blocker；只有涉及产品身份的取舍才进 §5。

## 约束

- 不推翻数据模型（sessions / trees / nodes 等表不改），方案必须能在现有模型上分波实施。
- 保留体检 §5「值得保留的东西」；参考方向 1 / 2 但不受它们限制。
- 手机壳已有裁决（`progress/mobile-shell.md`），方案要兼容，不重开手机首屏之争。
