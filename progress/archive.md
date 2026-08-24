# Trellis Archive

历史 session log（按时间倒序）。

## Session Log

### Session 117（2026-08-22，定时任务固定入口：侧栏「⏱ 定时任务」分组 + 深链跳转修复）
- **触发**: 用户「希望给定时任务单独分配一个固定的工作区，通过左边的列表点进去看执行情况；现在点历史运行记录，跳转目标特别奇怪」。
- **根因（跳转奇怪）**: 任务会话 `kind='task'` 被 `/api/sessions` 全量排除 → 深链落地后侧栏无行可高亮、tab 条 `byId` resolve 不出该会话；且主页深链只 `loadSession` 不占 tab 位，`hydrate` 又把 preview tab 设回 `sessions[0]`——dev StrictMode 双跑下第二个 hydrate 实例在深链之后完成、覆盖 preview，**画面与 tab/侧栏指向两个不同会话**。
- **Done ① 侧栏固定分组（SessionSidebar）**: 新增「⏱ 定时任务」分组，行骨架来自 **tasks 表**（任务是常驻实体——没跑过的任务渲染灰行占位，不因会话未懒建而隐身）；有 home 会话的行走 SidebarRow（preview/pin/改名/归档/删除、running 脉冲与未读角标全部免费复用，`/api/runs` 本就不分 kind）；分组 ＋ 号跳 `/settings/tasks`；任务已删的存量孤儿 task 会话也列出不吞。
- **Done ② API**: `/api/sessions` 响应加 `tasks`（id/name/homeSessionId/enabled）+ `taskSessions`；repo 新增 `listTaskSessions()`；归档视图放宽 kind（`archived=1` 时 user+task 都列，`countArchivedSessions` 同口径）——否则归档的任务会话从每个列表里消失。
- **Done ③ 生命周期闭环（lib/server/tasks.ts）**: `updateTask` 改名/改目录同步 home 会话（title `⏱ name` / workspace_path）；`deleteTask` 把 home 会话翻回 `kind='user'`（历史落进常规列表）；新增 `detachHomeSession()` 挂在会话 DELETE / 归档 PATCH 上解绑指针（归档语义 = 历史收起、下次执行重开新会话）；`ensureTaskSession` 校验 home 会话行仍存活，悬挂即重建。
- **Done ④ 深链修复**: `page.tsx` 深链改走 `previewSession`（占 tab 位，与侧栏点行同路径）；`sessionStore.hydrate` 加 hydrated guard + `hydrateInFlight` 防重入（双跑并发），尾部 preview **只在空位落座**（深链先到就不挤）；`SessionTabs.byId` 并入 taskSessions。
- **Done ⑤ TaskToast**: run_started/run_finished 事件 `bumpSessionsRevision()`（首跑懒建的会话行即时长出）；点击 toast 从 `window.location.href` 整页刷新改为 store 内 `previewSession + setActiveNode`（同路由改 URL 本就不触发深链 effect，老写法靠整页重启 store 才凑效）。
- **验证**: tsc 0 错；bun test 26/26；隔离 dev（:3199、mock provider、`TRELLIS_SCHEDULER=off`、独立 `TRELLIS_DB_PATH`）curl 全链路实测——建任务→tasks 字段灰行→首跑懒建 `⏱` 会话且不混入 user 列表→改名同步→归档解绑+归档区可找回→重跑重建新会话→删任务翻 user；agent-browser 实测深链落地三处一致（tab=⏱ 任务、侧栏分组行高亮、画布聚焦该次执行根节点），侧栏行来回切换正常。
- **Next**: 合并 main 后 `make deploy`；可选迭代——灰行（没跑过的任务）点击直跳设置页选中该任务。

### Session 116（2026-08-21，画布完全剔除隐藏树 + 大纲分组与一键恢复）
- **触发**: 用户反馈隐藏的树在画布上仍然会出现。
- **根因**: `Canvas.tsx` 中 `hiddenIds` 仅通过 `hiddenByCollapse` 处理折叠节点的后代，未将 `hiddenAt !== null` 的雪藏树（根及全部后代）加入排除集合；`Outline.tsx` 未区分可见树与雪藏树，且缺少对雪藏树的恢复/隐藏控制。
- **Done**:
  1. `lib/collapsed.ts`: 新增 `hiddenCanvasNodeIds`，统一将「折叠节点的后代」以及「雪藏树（`root.hiddenAt !== null`）根与全部后代」纳入隐藏 ID 集合；补充 `lib/collapsed.test.ts` 单元测试。
  2. `components/Canvas.tsx`: `hiddenIds` 改用 `hiddenCanvasNodeIds`，在 Dagre 自动布局、`flowNodes`、`flowEdges`、焦点平移、页面挂载落地候选（`fresh`）中全面排除雪藏树。
  3. `components/Outline.tsx`: 区分 `visibleForest` 与 `hiddenForest`；增加 `已隐藏 · N 棵` 折叠分组（默认收起，全隐藏时自适应展开）；根节点行新增悬停隐藏/恢复按钮，支持在思维树大纲直接隐藏或恢复树，并自动切换焦点。
  4. `stores/sessionStore.ts`: `setViewMode("canvas")` 切换至画布时，若焦点所在树为隐藏树，自动回退到首棵可见树根。
- **验证**: `bun test` 26/26 全部通过（覆盖 collapsed、tree-panel、format-tokens、context-usage）；相关逻辑零报错。
- **Next**: 合并至 main，下次 `make deploy` 部署上线。

### Session 115（2026-08-21，树命名/重命名支持：PATCH API + Store 乐观更新 + 树面板行内编辑）
- **触发**: 用户提问「能支持对 树 命名吗」→ 评估可行性后立即落地。
- **Done ① API & Store**:
  1. `app/api/nodes/[id]/route.ts`: 新增 `PATCH` 处理器支持更新 `topicLabel`，调用已有 `repo.setNodeTopicLabel` 落库 `nodes.topic_label`。
  2. `stores/sessionStore.ts`: 新增 `renameTree(nodeId, title)` action，自动向上回溯根节点，乐观更新 `node.topicLabel` 并发送 API 请求，失败自动回滚。
- **Done ② UI 交互（TreePanel）**:
  1. `components/TreePanel.tsx`: 当前活跃树头行（`renderActiveTree`）与折叠态树行（`renderTreeRow`）全面支持树重命名——双击树名或悬停点击重命名按钮（铅笔图标）进入行内编辑 `<input>`，支持 Enter / onBlur 提交与 Escape 取消。
  2. 命名联动：所有视图（TreePanel、Outline、Header、Canvas）统一消费 `treeLabel(root)`，修改后全站即时同步。
- **验证**: `bun test` 26 pass ✔；`node_modules/.bin/tsc --noEmit` 0 错 ✔；`eslint` 0 错 ✔；`bun --bun run build` 成功通过 ✔。
- **Next**: 提交分支、提交 PR 并合并至 master/main。

### Session 114（2026-08-21，Token 统计精准化 + 单卡耗时 & Token 使用 & 纯模型 TPS 仪表）
- **触发**: 用户反馈两个问题：① 当前 token 统计不精确；② 最好能在每个卡片展示耗时 & token 使用 & TPS。
- **根因 & Done ① Token 统计精准化**:
  1. `lib/format-tokens.ts`: 原先 ≥10k 粗暴 `Math.round(n/1000) + 'k'`（如 12.4k 变成 12k、85.6k 变成 86k，抹杀数百 token 精度）。改为 1k~1M 均保留 1 位小数（整千自动去尾 `.0`，如 `12.4k`、`15k`、`125.4k`），≥1M 保留 2 位小数（如 `1.25M`）。
  2. `lib/server/cli-import.ts`: 多步工具调用 turn 中原先只取最后一条 assistant 消息的 `lastUsage`（丢失该轮前期全部工具调用的 token）。修复为全轮所有 assistant message 的 token 累加（input / output / cacheRead / cacheCreation 逐项求和），`contextTokens` 精确取末条占用。
  3. `lib/server/codex-import.ts`: 优先消费 `info.total_token_usage`，多步工具与 token 累积一致。
- **Done ② 单卡耗时 & Token 使用 & 纯模型 TPS 展示**:
  1. 数据流与落库：`nodes` 加 `duration_ms INTEGER` 列，`run-bus` 记录提问到 done 的总耗时并在 done 事件及 `finalizeNode` 中落库；`cli-import` 与 `codex-import` 计算每轮时间差回填 `durationMs`。
  2. 组件 `TurnStatsMeta`: 统一计算并渲染 ⏱️ 耗时（流式态秒级跳动、done 态精确显示）、Token 细分（↑输入 ↓输出 ⚡缓存，带高精度 hover 详情）、⚡ TPS（`outputTokens / llmDurationSeconds`，**自动合并并扣除工具执行时间**，准确反映 Model API 生成速率）。
  3. 视图接入：`TurnCard`（线性视图/工作台）底部操作栏左侧嵌入 `TurnStatsMeta`，流式期间与完成态自适应；`ChatNode`（画布视图完整卡片与紧凑卡片）接入 `TurnStatsMeta`，全端体验对齐。
- **验证**: `bun test` 17/17 全过（涵盖精度、耗时格式化、工具时间区间合并与扣除、TPS 纯模型速率计算）；`tsc --noEmit` 零错；`scripts/test-cli-jsonl.ts` 与 `scripts/test-tool-tree.ts` 全绿。
- **Next**: 合并至 main，下次 `make deploy` 部署上线。
