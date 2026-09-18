# plan（leader 拆解的计划；fj next 按依赖推「可起」，fj status 顶部画目标图）

写法：`- [ ] id: 一句话 | after: a,b | mode: readonly | kind: codex | keep-seat`，缩进两格的续行写多行目标或 `verify: <命令>`。
id 只用 [a-z0-9-]；after 写依赖项的 id（都验收通过才可起）；keep-seat = 验收后坐席留着给下一单复用（review 循环用）。
状态不用手改：绑了 cid 的项从任务推导；没绑的 [ ] 待做、[x] 已做、[-] 放弃。

目标：修 BOE devbox prod 卡顿的两处 watcher 缺陷：A herdr-fleet 对不可解析 transcript 无限重试；B cli-sync 对超大 transcript 全量重 parse 阻塞事件循环
- [ ] fix-a: herdr-fleet：0-turn transcript 判为 empty 不报错；attach 失败区分可重试与确定性失败，后者不清 key（去重不失效） | seat: worker
  cid: fj-fix-a-ce8d
  改 lib/server/herdr-fleet.ts attachTranscript 的 catch 与 lib/server/cli-sync-watcher.ts seedLineage 的 throw。带单测。
- [ ] fix-b: cli-sync reimport：mtime/size 短路 + 增量 parse（只读新增字节），大文件不再阻塞事件循环；debounce 对持续写入合并成安静后解析 | seat: worker
  cid: fj-fix-b-facc
  改 lib/server/{cli-import,codex-import,cli-transcript,cli-import-db,cli-sync-watcher}.ts。带基准与单测。与 fix-a 无依赖，并行。
- [-] review: 异源 review fix-a + fix-b：重试语义、增量 parse 正确性（截断/并发写/回滚）、两分支合并后零回归 | after: fix-a,fix-b,fix-c | mode: readonly | seat: reviewer-codex | keep-seat
- [-] release: 起位前问用户：两分支合 main、本机 prod 部署与否由用户定；devbox 侧由对方拉取 | after: review | gate: review
- [ ] fix-c: SQLite 写失败前端明确报错（不再静默转圈）+ 磁盘水位告警与健康端点字段 | seat: worker
  cid: fj-fix-c-19ee
  devbox /data00 94%、13:39 三次 SQLITE_FULL。与 fix-a/fix-b 并行，禁区：herdr-fleet / cli-sync-watcher / cli-import* / codex-import / cli-transcript。
- [ ] review-ab: 异源 review fix-a + fix-b 的集成分支：重试语义、增量 parse 正确性与基准可复现、合并后零回归 | after: fix-a,fix-b | mode: readonly | seat: reviewer-codex | keep-seat
  cid: fj-review-ab-2c36
  waiver: {"at":"2026-09-18T08:11:24.517Z","reason":"唯一 fail 项 F1（fork 文件存在但 EACCES 时 anyUnreadable 判 false，清理会删已有 fork 节点）是 main 存量缺陷，review 自己用 git show 6510127 归因确认非本次合并引入；A/B 修的是线上正在烧的 CPU 火（devbox 已被迫 TRELLIS_HERDR=off 止血）。A 的核心断言经变异测试红→绿、B 的真样本等价性与基准量级均独立复现通过。F1 与 fix-c 列出的三处上游接口合成 fix-d 紧接着做。M1 只是把 3.2% CPU 的适用条件写清楚，m1 是空会话 UI 提示建议，均不挡合并。","cid":"fj-review-ab-2c36","settlement":"[\"d5748fb2dd6b36ef1451cbe98208f4f0efabd2209af99bde9eb09f69b8e7a88d\",0,[\"2026-09-18T08:10:55.027Z\",\"d5748fb2dd6b36ef1451cbe98208f4f0efabd2209af99bde9eb09f69b8e7a88d\",\"646f886f98bf081e3be9300cf36a7487f7d5b379f6c21dada953135233a9c977\",4,0,\"fail\",\"21ccba4b2815cb21cc932b659e812f1286a31faea1aad38459b7b009eb677220\"]]"}
- [ ] release-ab: A/B 合 main + 本机 prod 部署（用户已授权免问）+ 通知 devbox 拉取 | after: review-ab | gate: review-ab
