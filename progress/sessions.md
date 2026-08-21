# Session Log

最近 5 条，倒序（Session 114 / 113 / 112 / 111 / 110）。更早的见 `archive.md`。

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

### Session 113（2026-08-21，模型选择与管理体验重构：可搜/分类/最近 + 预设模版一键填入 + 可视标签）
- **触发**: 用户反馈「模型的选择和管理太不友好了，选择上需要下拉逐个找，设置页设置模型时也需要手动输入」。
- **Done ① ModelPicker 模型选择下拉重构**: 顶部增加即时搜索栏（拼音/厂商/模型名模糊过滤，带清空与全键盘快捷键上下导航 Enter 选择）；新增「全部 / 常用 / Claude 系 / Codex 系 / 第三方」快速分类 Filter Pills；集成 `localStorage` 最近使用模型记录（快捷置顶，1 键切换）；卡片增加厂商 Badge 标识、上下文窗口容量（1M/200K 等）与状态提醒（跨系需新建会话、缺 Key）；空结果智能引导添加。
- **Done ② ModelConfigPanel Provider 管理与预设模版**: 新增主流大模型（DeepSeek、Kimi、通义千问、智谱 GLM、MiniMax、火山引擎 Ark、SiliconFlow、OpenRouter、Ollama、OpenAI）预设模版一键填入端点、环境变量与模型列表；模型管理支持可视 Tag 增删、候选推荐一键添加以及多行文本双模式；新增可视化一键设置 `endpoints.yaml` 全局默认模型（`setDefaultModel` + PATCH 接口）。
- **Done ③ LabelModelCard 打标/起题模型配置提升**: 提供 Claude 系与 Codex 系推荐快捷 Tag（默认 haiku / mini 等）与可用模型下拉选择器，告别手动输入。
- **Done ④ Agent 管理模型字段提升**: 自定义 Agent 模型配置支持快捷预设 Tag 与全量 Provider 模型分类下拉选择器。
- **验证**: `bun --bun run build` 与 Next.js turbopack 编译 100% 通过（零类型/语法错误）；无多余依赖与无侵入式回退保护。
- **Next**: 合并至 main，下次 `make deploy` 部署上线。

### Session 112（2026-08-21，树隐藏修复：彻底移出非隐藏区 + 焦点自动切换 + 已隐藏组展开自适应）
- **触发**: 用户反馈树隐藏问题——当前树或只剩一棵树时点击隐藏，该树仍旧出现在非隐藏区，或者说只要停留在当前树该树就不在隐藏区里，且存在双重渲染。
- **根因**: `TreePanel.tsx` 存在 `{activeEntry?.hidden && renderActiveTree(activeEntry)}` 强制把被隐藏的当前树再次渲染在热区下方；同时点击隐藏时未自动把活跃焦点切换到下一棵可见树；activeRootId 回退时未优先选择首棵可见树。
- **Done**: ① `TreePanel.tsx` 删去 `activeEntry?.hidden` 在非隐藏区的强制渲染；② 隐藏当前树时（无论是在展开树头还是折叠树行点击），若存在其他可见树则自动将焦点切至下一棵可见树（`nextVisible.latestNodeId`）；若恢复隐藏树且当前无可见活跃树，自动恢复其活跃状态；③ `activeRootId` 缺省 fallback 优先选择第一棵未隐藏树（`entries.find(e => !e.hidden)`）；④ `renderTreeRow` 补全 `entry.hidden` 下当前被选树的 active 样式；⑤ `hiddenOpen` 支持全树被隐藏时默认展开 `已隐藏` 组，便于用户快速恢复；⑥ 新增 `lib/tree-panel.test.ts` 覆盖分组、雪藏过滤、热度排序及单树雪藏等场景。
- **验证**: `bun test` 9 pass ✔；`node_modules/.bin/tsc --noEmit` 0 错 ✔；`eslint` 0 错 ✔；`bun --bun run build` 成功通过 ✔。
- **Next**: 提交分支、提交 PR 并合并至 master/main。

### Session 111（2026-08-21，打标/起题模型可配：app_settings kv + 设置页卡片）
- **触发**: S110 交付后用户追问「别人用但没有这些模型呢」→「能不能在设置里配」。此前 claude 路写死 `--model haiku`（官方 alias，正常安装都认，但只路由部分模型的网关/自建 cpa 类环境会静默失败）。
- **Done**: ① `app_settings` kv 表（服务端 app 级偏好的通用归宿——localStorage prefs 服务端读不到，spawn 路径要读的偏好从此有家）+ repo `getAppSetting/setAppSetting`（空值=删行回默认）；② `/api/settings` 白名单路由（GET 全量 / PATCH 单键，key 白名单制防长尾垃圾键）；③ topic.ts 读 `label_model_claude`（默认 haiku）/ `label_model_codex`（默认不传 `-c model=` 走本机默认），topic+title 两用途共用；④ `LabelModelCard` 挂 settings/models 页（与 AuthHealthCard 同级，不进 ModelConfigPanel——那组件被 modal 复用且管的是 endpoints.yaml 跨应用共享配置，起题模型是 trellis 私有偏好不该混入）。
- **验证**: tsc/eslint/`bun --bun run build` 零错；隔离 dev（副本库 :3891）**双向对照**——kv round-trip ✔；配 `no-such-model-xyz` 发一轮 chat → SSE 无 topic_label/session_title（证明配置真进 spawn、失败静默不伤对话）；清除后再发 → 两事件恢复（「并发编程活锁」/「活锁现象解析」）✔；agent-browser 实测设置页卡片渲染 + UI 保存 → API 回读 `sonnet` 落库 ✔。
- **Next**: 与 S110 同批**未提交未部署**，用户过目后一起提交；后续想给别的服务端偏好用 kv 直接进 `/api/settings` 白名单。

### Session 110（2026-08-21，体验 A/D 落地：发问相似检测 + 会话自动命名，顺带修 topic_label 超时暗伤）
- **触发**: 用户「树多了不知道在哪棵续聊还是新开」→ 痛点拆三层（①没想起来聊过——决策时机层，⌘P pull 式救不了 ②记得但搜不到——trigram 换措辞 miss，即 C3 ③找到树不知在哪节点续），方案 A（push 式相似检测）+ D（自动命名地基）拍板先做。
- **Done A（发问时相似检测，roadmap 记 C7）**: `repo.findRelated`——与 searchAll 整句 phrase 不同，草稿拆多 term（ASCII 整词 + CJK 3 字窗步 2 + 尾窗，会话腔停用表双向 includes 过滤）各查一次 FTS，按 session 聚合 term 覆盖度，门槛 ≥2 term（单 term 查询放宽 1）+ 排除 archived，宁漏报不误报；新路由 `/api/search/related`；`RelatedHints.tsx` 挂 QuestionInput 输入卡下——debounce 600ms、≥6 字才查、`/` `$` 前缀跳过、✕ 压制当前草稿（清空复位，react-hooks 新规不让 effect 内同步 setState → 渲染门控 + prev-render 对比实现）、点行走 jumpToSearchHit 直落原树线性视图命中节点。
- **Done D（会话自动命名，roadmap 记 C8）**: sessions 加 `title_source`（default/auto/user）迁移 + 存量回填（title ≠ 根节点首问前 60 字 → user；导入系派生规则不同天然 mismatch 也标 user = 保守正确）；renameSession 置 user 永久锁；run-bus 新增 `sessionTitle` post-done 钩子（**与 topicLabel 并发跑**——两钩子各一次 CLI spawn，串行最坏顶穿 30s grace window）+ `session_title` 事件广播/迟到订阅补发；chat route 闭包判定全走 DB（origin=native only——retry 路径不回填 resolvedOrigin 故不信 route 变量；doneCount==1 首答起题、%8==0 按最近 3 轮刷新「当前主题」）；`generateSessionTitle` 与 topic 共用 spawn 管道（haiku）；store 收事件就地改当前 session 标题 + bump sessionsRevision 让 sidebar/tabs 重拉；`applyAutoTitle` 的 `WHERE title_source != 'user'` 原子守卫防与手动改名竞态。
- **顺带破案（存量暗伤）**: topic.ts 的 claude 8s 超时一直在静默掐死打标——`claude -p --model haiku` 冷启动实测 10.6s（热 4.2s），历史 topic_label 命中率仅 49/493≈10%。超时提 15s（并发取 max，30s grace 内），topic_label 与 session_title 同受益。
