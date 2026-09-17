# plan（leader 拆解的计划；fj next 按依赖推「可起」，fj status 顶部画目标图）

写法：`- [ ] id: 一句话 | after: a,b | mode: readonly | kind: codex | keep-seat`，缩进两格的续行写多行目标或 `verify: <命令>`。
id 只用 [a-z0-9-]；after 写依赖项的 id（都验收通过才可起）；keep-seat = 验收后坐席留着给下一单复用（review 循环用）。
状态不用手改：绑了 cid 的项从任务推导；没绑的 [ ] 待做、[x] 已做、[-] 放弃。

目标：动线优化：按参考稿 final.html 重做会话页「🧰 动线」卡与 Workflow（dynamic workflow）进度面板，先记现状再改，异源 review 后上线
- [ ] baseline: 现状记录：隔离实例 + 真库副本，截图桌面/手机的动线卡、Workflow 面板、子 agent 卡、长跑 Bash 行，列出有数据没渲染的字段与可用性问题 | mode: readonly | seat: gemini
  cid: fj-baseline-3a12
  交付 out/baseline.md 与 out/shots/*.png；只读、不改源码；供 impl 做 before/after 对照。不依赖参考稿，可立即起。
- [ ] impl: 按参考稿重做动线卡（ToolTimeline/ToolRow）与 WorkflowView：单一时间线 + dynamic workflow 进度面板对齐参考效果，桌面与手机各验一遍
  cid: fj-impl-c36d
  阻塞：等用户提供 final.html（10.37.126.170 内网，本机不可达）；拿到后由 leader 读稿写具体目标再起。参考 progress/agent-flow-rendering.md 与 facts.md 第 45–47 条（workflow_progress 全量快照字段）。不依赖 baseline 的代码，只把它的截图当输入，故不写 after。
- [ ] review: 异源 review impl：参考稿对齐度、降级铁律（视图不匹配回 RawView、error 永远全显）、桌面零回归、手机 44px、脚本实跑 | after: impl | mode: readonly | keep-seat
  cid: fj-review-f461
  以 impl 的 worktree 为输入；fail 只认结论/行为错、伪造、凭证泄露、破坏现有测试。
- [ ] release: 起位前问用户：impl 分支合 main、全套脚本实跑、make deploy 上线并验活，失败即回退 | after: review2 | gate: review2
  动生产，起位前必须问用户（授权卡）。
- [ ] fix1: 按 review M1/M2/m1 返工：畸形快照回 RawView 不抛错、错误行渲染 stderr、折叠预算按实际列数；脚本端口/锁可覆盖 | seat: worker
  cid: fj-fix1-0af4
  输入 /tmp/flow-review-r1/（review.md + 两个探针）；不写 after：review 的 M1/M2 结论已在手，其余动态项与本单无关。
- [ ] review2: 复审 fix1：用同一探针重打 M1/M2/m1，复跑四条 verify 与 workflow-card.sh，浅色截图，生产 chunk 无 store 把手 | after: fix1 | mode: readonly | seat: reviewer-codex | keep-seat
  cid: fj-review2-6ef7
  以 fix1 后的分支 tip 为输入；fail 只认四种。
  waiver: {"at":"2026-09-17T13:21:02.942Z","reason":"review2 五项 UI 修复全部复测通过，唯一 fail 项是返工带入验收脚本的假绿（bash 3.2 下 $VAR（ 吞全角字符早退、trap 返回 0）。leader 轻档自修：全部变量加花括号 + EXIT trap 拦早退，默认 locale 完整复跑到末尾 PASS（/tmp/flow-fix2-run.log，含 559/560/561 与手机规模段），提交在 feat/flow-redesign。","cid":"fj-review2-6ef7","settlement":"[\"f46037b7637e294842f94aa61e2e40705f6da1e6bac7f7de8fcf453cfa69f283\",0,[\"2026-09-17T13:17:22.351Z\",\"f46037b7637e294842f94aa61e2e40705f6da1e6bac7f7de8fcf453cfa69f283\",\"f843175729e67a063baaa9ee4da427a54dcbf51b5341348bc2e88e977fe3ca79\",7,0,\"fail\",\"5a1465686f7f797a2da4d7374bcd7c8e812ff85e06cdf67c594c3ce393febde7\"]]"}
