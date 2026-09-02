### Session 135（2026-09-02 晚，leader 编队：定时任务 → agent → 飞书打通，形态 2「任务落进飞书会话」；分支 `feat/task-lark-landing` 双审通过待合并）
- **触发**: 用户问「定时任务能和 agent + im 打通吗」。先派只读查证（Sonnet Explore）读代码，结论四段：任务→agent 已通（`tasks.ts` 真套用 agent 的 prompt/tools/skills，agent 为空静默退化）；IM→agent 已通（S134）；任务→IM 未通（NotifyEvent 不带正文、`sendLarkText` 只在入站闭包里可用、manager 不导出实例）；IM→任务空壳（`TriggerKind` 含 `lark` 但零消费者）。三种形态里用户拍板形态 2：任务绑定飞书落点，每次 run 在该 chat 的 `kind='lark'` 会话里长新树，结算后推送，话题追问接叶子、引用即分支。
- **编队**（herdr-leader，契约 + 独立结算 + 异源 review）:
  1. 实现：codex gpt-5.6-sol xhigh（cpa 通道），worktree `~/worktrees/trellis/task-lark-landing`。32 分钟交付 commit 6c75fcc（14 文件 +766/-52）；8 条 verify 主控独立复跑全绿（tsc / bun test 52 / 飞书断言 55→67 / build / 真库在线备份副本迁移 / 活体记录 / spec / 提交）。活体验证在隔离实例（`TRELLIS_DB_PATH` 副本 + `TRELLIS_LARK=off` + 失效 secret）走 API 建绑定群任务并手动跑一次：新根落在群「消息推送」的既有会话、run done、日志命中 `[lark] dry-run push`、outbox 0 行，全程未发真实飞书消息。
  2. 异源 review：Claude 官方 opus（Max 订阅），只读契约，16 分钟 verdict pass，8 条 minor 全带 PoC。关键发现：F2 push helper 三次查库在 try 外且调用点 `void` 无 catch → 库故障时未捕获拒绝会直接杀掉 Bun 进程（settle 抓不到的结构性问题）；F1 深链是相对路径在飞书里不可用；F3 私聊推送后推进链尾 / F4 落点会话的 context_mode、workspace_path 归 bot 所有——两条语义取舍。
  3. 主控裁决：修 F1（新增 `TRELLIS_PUBLIC_URL`，未设退回纯文案）/ F2（查库进 try + 调用点 catch）/ F5（超时文案与 notify 共用 `task-push-policy.ts` 映射）/ F6（空回答不推）/ F7（停用 bot 拒绝绑定；运行时回退经 notify 可见）/ F8（补 15 条断言 → 82）；F3 保留「收到报告直接追问即接上，旧对话用引用接回」写进 spec；F4 写 spec + UI 提示「追问将在该机器人的工作目录中执行」；两条未证实疑点写进 spec「已知行为」。返工 12 分钟 commit 4c518ec（7 文件 +295/-89），再次 settle 全绿。
  4. 复审：同一 opus 坐席只审增量，5 分钟 verdict pass，8 项全部「已修」且逐项复跑 PoC（F1 九种 URL 形态、F2 六个注入点抛错均不 reject 且进程存活）。新发现 2 条 minor 记为遗留：N1 回退告警不受 `notify_on` 约束且无去重（cron 任务 chat 被删就每次一条）；N2 F4 提示无条件渲染（选「不落飞书」也显示）。
- **产物**: 分支 `feat/task-lark-landing` 两个 commit（6c75fcc + 4c518ec，未 push）；spec `progress/task-lark-landing.md`（在分支上）；review 报告与结算记录在 `.fenjue/archive/fj-task-lark-{landing-7ecd,review-edb7,rereview-4c67}/`；台账 `.fenjue/ledger/DECISIONS.md` +3 行。三坐席已退位，worktree 保留。
- **顺手核出的事实**: `lib/server/sqlite.ts:14` 早有 `TRELLIS_DB_PATH` 覆盖（5af57a2 起），S133 memory「无 env 覆盖」是错的，已订正 memory 与 facts；飞书关闸真源 `lark/manager.ts:154`。fj 契约门禁两个坑（desc 含 `x: y` 要加引号；`done_when[].id` 必须 `D\d+`）与 codex 三种沙箱框（写主仓 `.fenjue/`、绑端口、写 out/）已回填 herdr-leader seats.md。
- **Next**:
  1. **用户拍板**：推分支 + 开 PR → 合并 → `make deploy`。上线前给 prod launchd 配置加 `TRELLIS_PUBLIC_URL`（否则飞书消息只有文案没链接）；部署 smoke 走 `TRELLIS_LARK=off`，不会误推。
  2. 真群验收（用户触发，需真发消息）：把「仓库日报（试跑）」任务绑 agent + 落点群「消息推送」→ 手动跑一次 → 群里出现推送 → 话题内不 @ 追问接叶子 → 引用推送提问在该节点下分支。这同时就是路线 A 的第一个 dogfood 用例。
  3. 小修候选（可并入 PR 前的第三个 commit，或进 backlog）：N1 回退告警按 taskId 节流并尊重 `notify_on`；N2 提示仅在已选落点时渲染、无 workspace 时改文案。
  4. 未做（spec「不做」节）：`kind='lark'` 触发器（IM→任务）、每群 agent 覆盖、卡片 / 流式回复、trellisctl 与 `skills/trellis-admin` 学新字段（后者建议尽快补，否则 CLI 建的任务绑不了落点）。
  5. 合并后清理：`herdr worktree remove`（workspace w1C）+ `/tmp/fj-tll-*`、`/tmp/rev-*.db`、`/tmp/re-*.ts` 草稿；本 session 的 progress 改动未提交（README Focus、facts +1、本条）。
