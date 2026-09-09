目标：把波 3 做成右侧 push 式整列的「结构」面板，改回**旧 TreePanel 那种小浮窗 + 小点的形态**。用户原话：「我还是感觉原先的那种小浮窗+小点的交互比较合理」。内容模型（话题森林 + 当前话题 + 当前链高亮 + 其它分支 + 地图入口）保留，只换形态。

## 参照

- 旧形态截图：`/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-ui-audit-7b23/out/shots/d-05-linear-web3.png` 右下角那个小窗——约 290px 宽、不到半屏高、紧贴右下、圆角卡片；标题栏「树 · 124 · + 新树 · ⌥ · 🔍」；每行一个节点，缩进表示层级，行首**小圆点**表示状态（已读/未读/等待处理），当前节点高亮；不占列宽、不推挤正文。
- 旧代码：`git show 013adb9:components/TreePanel.tsx`（波 2 合并时的版本）与 `git show 013adb9:components/Outline.tsx`；现行代码：main 上波 3 的结构面板（`git log --oneline main -- components | head` 找到波 3 合并 PR #53 的文件：结构面板组件、`app/page.tsx` 布局、`LinearThreadView.tsx`）。
- 方案文 `progress/sidebar-tree-ia.md` §2.3 的概念不变：话题 = 一棵树、链 = 阅读位置、其它分支。

## 要求

1. **形态**：结构面板改为固定在右下角的浮动小窗（默认尺寸与位置对齐旧 TreePanel：宽约 290px、最高约 45% 视口高，可滚动），不再是 push 整列；正文列宽度恢复到波 2 时的状态（「宽」档 958px 左右不被压窄）。小窗可收起为一个小徽标（显示话题数/未读数），点开恢复；展开/收起状态持久化。**不得遮住 Composer 的附件/草图/发送三键**（旧版就没遮，参照其底部留白）。
2. **小点**：每行行首状态圆点沿用旧语义（已读 / 未读 / 等待处理 三色，与地图图例一致），当前节点行高亮 + 左侧 accent 条；话题行（树根）加粗并显示节点数；「其它分支 N 条」作为当前话题下的折叠行。
3. **内容与能力不变**：递归森林、当前话题默认展开、当前链高亮、点击行落到正文对应节点、键盘可达（方向键/Enter/Esc）、新话题按钮、过滤/只看未读、地图入口（🗺 按钮打开波 4 的地图覆盖层，不改地图）。手机端不动（沿用全屏 sheet）。
4. **画布视图**（若还有旧画布入口）与线性视图共用同一个浮窗组件。
5. 与体检 P1-1 的关系：用户明确接受浮窗形态，所以「零重叠」不再是判据；但要求在「宽」档下浮窗落在右侧留白区、尽量不压正文，「超宽」档允许压。

## 验收

- 生产库快照隔离实例（端口 3503）截图：桌面 1440×900 线性视图「宽」档浮窗展开态 / 收起态 / 分叉会话（≥3 分支）展开态 / 124 节点会话浮窗；与旧截图 d-05 并排放一张对照；手机一张确认未回归。DOM 实测：正文列宽恢复（给出 `.md-body` 宽度数字，对照波 2 时 ~958px）、Composer 三键可见不被遮。
- `bunx tsc --noEmit`、`bun test` 全绿；11 条手机脚本统一前缀独占跑绿（前缀 `env -i HOME=/Users/smokingmouse PATH="$PATH" TRELLIS_LARK=off TRELLIS_SCHEDULER=off TRELLIS_HOOKS=off TRELLIS_HERDR=off TRELLIS_VERIFY_SOURCE_DB=/Users/smokingmouse/.trellis/data.db`），跑完 3471–3480 与 3503 无监听、锁已清；针对 push 面板的旧断言按新形态改并写明。
- 提交到本 worktree 分支 `fix/structure-floating-panel`，工作树干净；不 push、不 PR、不部署；**不改 `progress/README.md`**（可加 progress/sessions 记录）。**不发 partial result**，完成后发唯一一封 done，result.md 附截图路径与对照说明。
