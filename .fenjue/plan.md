# plan（leader 拆解的计划；fj next 按依赖推「可起」，fj status 顶部画目标图）

写法：`- [ ] id: 一句话 | after: a,b | mode: readonly | seat: reviewer | keep-seat`，缩进两格的续行写多行目标或 `verify: <命令>`。
id 只用 [a-z0-9-]；after 写依赖项的 id（都验收通过才可起）；keep-seat = 验收后坐席留着给下一单复用（review 循环用）。
seat 引用 policy.md / 全局 seats 预设；task go --plan <id> 一步准备工作区并起位；keep-seat: false 显式关闭 policy 留位缺省。
gate: review-id 要求报告交付已验收且 review_verdict=pass，或该项有有效 waiver；fail / none 不解锁 gate，fix 用 after: review-id。
fj plan waive <review-id> --reason "原因" 记录本次 review 的豁免；重绑或重新结算后需重新确认。
状态不用手改：绑了 cid 的项从任务推导；没绑的 [ ] 待做、[x] 已做、[-] 放弃。

目标：sub2api 号池巡检 bot 上线；顺势把 trellis 建 bot 做成扫码一站式（创建 → 确认权限 → 自动绑定），已有 bot 缺权限也扫码补

- [x] push: 任务推送小改：只推最终答复（finalStart）、[SILENT] 不推、卡片带任务名标题、<at> 在文本降级时转换
  leader 轻档自做，分支 feat/lark-ops-bot；改 tasks.ts / task-push-policy.ts / push.ts / sdk.ts 降级分支 / card.ts summary / handler.ts 回复正文。
- [ ] access: bot 对话审批：按 bot 的发送人白名单 + 管理员私聊卡片审批（文字命令兜底）+ 挂起消息放行后重放 + 设置页名单管理 | seat: gemini37
  cid: fj-access-c7de
  verify: bun x tsc --noEmit
  verify: sh -c 'out=$(bun test 2>&1); echo "$out" | grep -qE "^ *[0-9]+ pass$" || exit 1; n=$(echo "$out" | grep -oE "^ *[0-9]+ fail$" | grep -oE "[0-9]+"); test "${n:-0}" -le 5'
  verify: bun --bun run build
  完整目标见 /data00/home/zhangpeng.pada/trellis/.fenjue/briefs/lark-access-goal.md（先通读再动手）。worktree 基线 = feat/lark-ops-bot（= main 425d47b）。open 模式零行为变化；避开 leader 并行在改的任务推送路径（brief 约束节列了文件与位置）。
- [ ] review-access: 异源 review access：门禁不可绕过、open 模式零变化、挂起重放不重复执行、按钮 value 伪造与非 admin 命令被拒、迁移可重入 | after: access | mode: readonly | seat: cpa-sonnet5 | keep-seat
  cid: fj-review-access-4822
  工具类 review，审 access 分支相对 feat/lark-ops-bot 的全部改动。做三件事：① bunx tsc --noEmit 与 bun test 复跑；② 隔离实例冒烟（sqlite3 .backup 出副本 + 独立 HOME + TRELLIS_LARK=off，参照 scripts/mobile-verify/），走一遍 approval 模式下 设置页切换 → 成员 API 增改查 的主路径；③ 读门禁、decideMember、card.action.trigger 回调、文字命令、重放五处代码找绕过路径。只报行为错误，不审风格。首行 verdict: pass|fail；fail 只认四种：结论或行为错 · 伪造或不可复现到影响结论 · 凭证泄露 · 破坏现有测试，其余写在 ## 建议 下；只列可操作问题（文件:行、命令输出）；只读，运行产物写 /tmp。
  waiver: {"at":"2026-09-24T09:00:58.436Z","reason":"唯一 fail 项 F1 已由 fix-1 修复（458b9bc）：先原子领取再 await，reviewer 同款并发复现改写成回归用例，旧代码 2 fail / 修复后全绿；修复属轻档且未改结论，按 playbook §4 不复审","cid":"fj-review-access-4822","settlement":"[\"fd6864dbef769e46b14295c7742d639040adfadf329e674e3488e40fb559270f\",0,[\"2026-09-24T08:55:42.834Z\",\"fd6864dbef769e46b14295c7742d639040adfadf329e674e3488e40fb559270f\",\"939df123f3bc08cd28d8ef841a612b47f05761ff2f25c8b728dd7b02b1589d2b\",2,0,\"fail\",\"5eee14616cb2acdd288c62919f8921e7336d6da0f83831816822f100f1c3f313\"]]"}
- [ ] watch: sub2api 巡检脚本 alert_watch.py：可行动告警规则 + 去重状态 + 号主 @ 映射 + [SILENT] 输出 | seat: gemini37
  cid: fj-watch-9a06
  完整目标见 /data00/home/zhangpeng.pada/trellis/.fenjue/briefs/alert-watch-goal.md。workdir 在仓库外（~/.claude/skills/sub2api-admin），走 task quick --workdir + launch；只新增三个文件、不 commit。
- [x] release: 起位前问用户：push + access 合 main、make deploy 上线并验活（动生产，必须问） | after: push,access | gate: review-access
- [x] config: 配置上线：登记新 bot（approval 模式）+ 设管理员、建只读 agent sub2api-ops、owners 映射、日报/巡检两任务推「sub2api 测试群」，手动各跑一次验 @ 与审批卡片再挂 cron | after: release,watch
  依赖用户在飞书建好应用并把 bot 拉进群；leader 自做（轻档），逐步给用户看效果。
- [x] fix-1: 修 review-access F1：审批先原子领取挂起消息再 await，并发批准/拒绝不重复重放/通知 | after: review-access
  leader 轻档自修（原实现坐席已退位）。回归用例旧代码 2 fail、修复后 23/23；全量 559 pass / 5 存量 fail；tsc 0。
- [ ] console: 开放平台收尾：补 im:chat:readonly / contact:user.id:readonly、长连接卡片回调 card.action.trigger、改名「号池巡检」、发版；之后用邮箱补 owners.json 的 open_id
  卡在飞书扫码登录（共享 Chrome 无登录态，用户经 localhost:6080 扫码后续派）。补完 open_id 巡检才会真 @ 号主；卡片按钮审批也要回调配好才生效（文字命令已可用）。
- [ ] cards-trellis: trellis 任务推送支持 Card 2.0 JSON 直通（最终答复是卡片 JSON 时原样发 interactive） | seat: gemini37
  cid: fj-cards-trellis-47cc
  verify: bun x tsc --noEmit
  verify: sh -c 'out=$(bun test 2>&1); echo "$out" | grep -qE "^ *[0-9]+ pass$" || exit 1; n=$(echo "$out" | grep -oE "^ *[0-9]+ fail$" | grep -oE "[0-9]+"); test "${n:-0}" -le 5'
  完整目标见 /data00/home/zhangpeng.pada/trellis/.fenjue/briefs/cards-trellis-goal.md。worktree 基线 = main 08d1cd5。
- [ ] cards-watch: 巡检脚本 --format card / --daily-card：结构化事件 + alert_cards 渲染 | seat: gemini37
  cid: fj-cards-watch-2158
  完整目标见 /data00/home/zhangpeng.pada/trellis/.fenjue/briefs/cards-watch-goal.md。workdir 在仓库外，走 quick --workdir + launch；只改三个文件、不 commit。
- [ ] qr-server: 扫码建 / 更新 bot 服务端：registerApp 会话 + 路由 + 立即对账 + 自动设管理员 + 欢迎私聊 + 缺权限解析 | seat: gemini37
  cid: fj-qr-server-c9dc
  verify: bun x tsc --noEmit
  verify: sh -c 'out=$(bun test 2>&1); echo "$out" | grep -qE "^ *[0-9]+ pass$" || exit 1; n=$(echo "$out" | grep -oE "^ *[0-9]+ fail$" | grep -oE "[0-9]+"); test "${n:-0}" -le 5'
  完整目标见 /data00/home/zhangpeng.pada/trellis/.fenjue/briefs/qr-server-goal.md。worktree 基线 = main 7c57fe5（契约类型已在 lib/lark-types.ts）。
- [ ] qr-ui: 扫码建 / 更新 bot 设置页：三步弹窗（填信息 → 二维码 → 已连接）+ 行内补权限 + 手动表单折叠 | seat: gemini37
  cid: fj-qr-ui-8c2b
  verify: bun x tsc --noEmit
  verify: sh -c 'out=$(bun test 2>&1); echo "$out" | grep -qE "^ *[0-9]+ pass$" || exit 1; n=$(echo "$out" | grep -oE "^ *[0-9]+ fail$" | grep -oE "[0-9]+"); test "${n:-0}" -le 5'
  verify: bun run build
  完整目标见 /data00/home/zhangpeng.pada/trellis/.fenjue/briefs/qr-ui-goal.md。worktree 基线 = main 7c57fe5（契约类型已在 lib/lark-types.ts）。
- [ ] review-qr: 异源 review 扫码建 bot：secret 不外泄、会话状态机与取消、update 校验 client_id / secret 轮换、对账 rerun、迁移可重入、UI 轮询与取消 | after: qr-server,qr-ui | mode: readonly | seat: cpa-sonnet5
  cid: fj-review-qr-f9a6
  审 main..feat/lark-qr-register 的 diff（leader 合并两单后建分支）。首行 verdict: pass|fail；fail 只认四种：结论/行为错 · 伪造或不可复现 · 凭证泄露 · 破坏现有测试，其余列建议。目标见 .fenjue/briefs/qr-server-goal.md 与 qr-ui-goal.md。
  waiver: {"at":"2026-09-24T11:15:01.709Z","reason":"F1/F2 两项行为错已由 fix-qr 修复（f71007e）：reviewer 两条复现改写成回归用例，旧代码 2 fail / 修复后全绿；两条建议（影子连接、404 无限轮询）一并修；修复属轻档未改结论，按 playbook §4 不复审","cid":"fj-review-qr-f9a6","settlement":"[\"a43e9420a1fe57e87ee614783674f2f8f8f2f3b4616a761e083a55c62fb80974\",0,[\"2026-09-24T11:09:15.946Z\",\"a43e9420a1fe57e87ee614783674f2f8f8f2f3b4616a761e083a55c62fb80974\",\"d29c34446800f68203ff8e91f347195856daee9a083a493743a2bb4e1e8f5369\",2,0,\"fail\",\"71698bf129762abc7b0c3819ebc2d0b2acfeee7aac23e153b6e11a499213f0c1\"]]"}
- [x] release-qr: 起位前问用户：扫码建 bot 合 main、make deploy 上线，和用户扫码做一次新建 E2E（动生产，必须问） | after: review-qr
- [x] fix-qr: 修 review-qr F1/F2：出二维码前失败立刻报真实原因；会话终态先到先得、binding 不可取消；reconcileNow 不起影子连接；弹窗 404 停轮询 | after: review-qr
