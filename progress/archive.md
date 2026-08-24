# Trellis Archive

历史 session log（按时间倒序）。

## Session Log

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
