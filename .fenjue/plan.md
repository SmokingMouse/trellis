# plan（leader 拆解的计划；fj next 按依赖推「可起」，fj status 顶部画目标图）

写法：`- [ ] id: 一句话 | after: a,b | mode: readonly | kind: codex | keep-seat`，缩进两格的续行写多行目标或 `verify: <命令>`。
id 只用 [a-z0-9-]；after 写依赖项的 id（都验收通过才可起）；keep-seat = 验收后坐席留着给下一单复用（review 循环用）。
状态不用手改：绑了 cid 的项从任务推导；没绑的 [ ] 待做、[x] 已做、[-] 放弃。

目标：动线优化：按参考稿 final.html 重做会话页「🧰 动线」卡与 Workflow（dynamic workflow）进度面板，先记现状再改，异源 review 后上线
- [ ] baseline: 现状记录：隔离实例 + 真库副本，截图桌面/手机的动线卡、Workflow 面板、子 agent 卡、长跑 Bash 行，列出有数据没渲染的字段与可用性问题 | mode: readonly | seat: gemini
  cid: fj-baseline-3a12
  交付 out/baseline.md 与 out/shots/*.png；只读、不改源码；供 impl 做 before/after 对照。不依赖参考稿，可立即起。
- [ ] impl: 按参考稿重做动线卡（ToolTimeline/ToolRow）与 WorkflowView：单一时间线 + dynamic workflow 进度面板对齐参考效果，桌面与手机各验一遍
  阻塞：等用户提供 final.html（10.37.126.170 内网，本机不可达）；拿到后由 leader 读稿写具体目标再起。参考 progress/agent-flow-rendering.md 与 facts.md 第 45–47 条（workflow_progress 全量快照字段）。不依赖 baseline 的代码，只把它的截图当输入，故不写 after。
- [ ] review: 异源 review impl：参考稿对齐度、降级铁律（视图不匹配回 RawView、error 永远全显）、桌面零回归、手机 44px、脚本实跑 | after: impl | mode: readonly | keep-seat
  以 impl 的 worktree 为输入；fail 只认结论/行为错、伪造、凭证泄露、破坏现有测试。
- [ ] release: 起位前问用户：impl 分支合 main、全套脚本实跑、make deploy 上线并验活，失败即回退 | after: review | gate: review
  动生产，起位前必须问用户（授权卡）。
