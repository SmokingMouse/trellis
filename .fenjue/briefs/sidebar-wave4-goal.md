目标：侧栏统一信息架构 **波 4 · 画布地图化**，按已拍板的方案 A（`progress/sidebar-tree-ia.md` §4「分波实施 · 波 4」第 13 条；体检报告 `.fenjue/archive/fj-ui-audit-7b23/out/ui-audit.md` §6 方向 2 与 P1-2 / P1-3）。用户已拍板：画布不再是第二种阅读视图，降级为导航地图。波 1–3 已在 main（工具条 + 项目树 + 右侧 push 式「结构」面板）。本 worktree 从合并后的 main 拉出。

## 本波范围

13. **画布 → 地图**：
   - 入口从「视图切换（线性 ↔ 画布）」改为「结构」面板里的「🗺 地图」（桌面：覆盖层或右栏内展开；手机：全屏 sheet 内的地图页），Header 上的画布切换与其相关文案退役（保留一个入口即可）。
   - 进入地图**必做 fitView** 并高亮当前节点位置；概览缩放下卡片退化为「带话题标签的色块 + 未读 / 等待处理点」，不再渲染正文摘要；悬停 / 聚焦时才展开一张详情卡。
   - 选中一个节点 = 关闭地图并落回线性视图的对应位置（滚到该节点并短暂高亮）。
   - 大会话可用：用生产快照里最大的会话（124 节点 / 10 棵树）验证桌面 1440×900 与手机 390×844 都能一屏看清结构且可读（色块 + 标签），并给出 `inView` 数字对照体检的 6/124。
   - Outline 已在波 3 解出，画布内不再单独渲染 Outline。
   - 线性视图的分叉、追问、审批等动线不变；`viewMode` 语义收敛（没有"画布阅读模式"这一档），旧的 URL 参数 / 本地存储值兼容处理并写明。

**不做**：LOD / 聚类 / minimap 这类大图渲染投入（用户选了降级路线）；不动 Composer；不动设置后台。

## 验收判据（写进 result 并给证据）

- 生产库快照隔离实例（端口 3501，`.backup` + `next start`，不碰 3088）截图：桌面地图打开（124 节点会话，fitView 后全貌 + 当前节点高亮）/ 悬停详情卡 / 选中落回线性并高亮；手机地图 sheet；再给一张 20 节点以下小会话的地图。DOM 实测：进入地图后视口内节点数 = 全部节点数（对照体检 6/124）。
- `bunx tsc --noEmit`、`bun test` 全绿；新逻辑（fitView 触发、色块退化阈值、选中落回、URL/存储兼容）有单测。
- 现有手机脚本统一前缀独占跑绿（前缀 `env -i HOME=/Users/smokingmouse PATH="$PATH" TRELLIS_LARK=off TRELLIS_SCHEDULER=off TRELLIS_HOOKS=off TRELLIS_HERDR=off TRELLIS_VERIFY_SOURCE_DB=/Users/smokingmouse/.trellis/data.db`）；针对旧「画布」入口的断言按新结构改并逐条写明；跑完 3471–3480 与 3501 无监听、锁已清。
- 回退：feature flag（沿用 `NEXT_PUBLIC_TRELLIS_SIDEBAR_V2` 或新增 `NEXT_PUBLIC_TRELLIS_CANVAS_MAP`），off 时保留旧画布视图一个版本；result 写明开关。
- **不发 partial result**，中间只用 progress；全部绿后发唯一一封 result（done）。提交到本 worktree 分支 `feat/sidebar-wave4`，工作树干净；不 push、不 PR、不部署。
