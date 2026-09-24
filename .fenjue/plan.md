# plan（leader 拆解的计划；fj next 按依赖推「可起」，fj status 顶部画目标图）

写法：`- [ ] id: 一句话 | after: a,b | mode: readonly | seat: reviewer | keep-seat`，缩进两格的续行写多行目标或 `verify: <命令>`。
id 只用 [a-z0-9-]；after 写依赖项的 id（都验收通过才可起）；keep-seat = 验收后坐席留着给下一单复用（review 循环用）。
seat 引用 policy.md / 全局 seats 预设；task go --plan <id> 一步准备工作区并起位；keep-seat: false 显式关闭 policy 留位缺省。
gate: review-id 要求报告交付已验收且 review_verdict=pass，或该项有有效 waiver；fail / none 不解锁 gate，fix 用 after: review-id。
fj plan waive <review-id> --reason "原因" 记录本次 review 的豁免；重绑或重新结算后需重新确认。
状态不用手改：绑了 cid 的项从任务推导；没绑的 [ ] 待做、[x] 已做、[-] 放弃。

目标：sub2api 号池巡检 bot：新 bot 在「sub2api 测试群」日报 + 异常巡检，授权掉/重置卡临期 @ 号主；bot 对话需管理员审批

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
- [ ] watch: sub2api 巡检脚本 alert_watch.py：可行动告警规则 + 去重状态 + 号主 @ 映射 + [SILENT] 输出 | seat: gemini37
  cid: fj-watch-9a06
  完整目标见 /data00/home/zhangpeng.pada/trellis/.fenjue/briefs/alert-watch-goal.md。workdir 在仓库外（~/.claude/skills/sub2api-admin），走 task quick --workdir + launch；只新增三个文件、不 commit。
- [ ] release: 起位前问用户：push + access 合 main、make deploy 上线并验活（动生产，必须问） | after: push,access | gate: review-access
- [ ] config: 配置上线：登记新 bot（approval 模式）+ 设管理员、建只读 agent sub2api-ops、owners 映射、日报/巡检两任务推「sub2api 测试群」，手动各跑一次验 @ 与审批卡片再挂 cron | after: release,watch
  依赖用户在飞书建好应用并把 bot 拉进群；leader 自做（轻档），逐步给用户看效果。
