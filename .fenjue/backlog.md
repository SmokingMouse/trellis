# backlog（fj next 在队列空了、policy.takeover=true 时从这里取下一单）

一行一单，取走标 [x]，不删。写法：`- [ ] slug: 一句话目标`（slug 只用 [a-z0-9-]）。

- [ ] mobile-wave1-nits: 一波 review 遗留 nit：N-1 删 8 处已被全局兜底覆盖的 max-md:text-[16px] 死代码；N-2 字号扫描器盲区（style 变量传入、globals.css 末尾追加规则）加廉价断言；N-3 手机 /settings/prefs 在 select 变 16px 后的布局截图确认；T-2 手机卡片非核心动作收进 …（已归二波）
- [ ] mobile-wave3-nits: 三波 review-c2 遗留：C2-1 收藏超过 50 条时第 51 条起 UI 不可达（「还有 N 条」改按钮提 limit 到 100 或 API 加 cursor 分页）；C2-2 别处取消的收藏本地不清（toggle 回包广播或定向核对）；C2-3 滚到底时恢复 chrome 的 scrollTop 补偿被 clamp 残留位移；H-3 useScrollHide 模块级单例
- [ ] new-session-reload: 分链修复 review-d2 遗留 D2-2：新会话首屏刷新后仍回上一个会话（URL 已清但 store 无「用户主动清空 session」的持久标记）；产品若要「新会话首屏可重载」需在 store 持久化该标记
- [ ] agent-server N1（review2 低危、自愈）：修法 #9 带出的窄面副作用，见 .fenjue/archive/fj-as-review2-29f0/out/review.md N1 小节；下次改 agent-server 时顺手带上
- [ ] agent-server 协议补只读 pending-request 通知（审批状态变化推送），让 Trellis 影子模式删掉 2 秒 thread/attach 轮询（migrate-1 review P1-3(c)）
- [ ] agent-tui 审批卡下粘贴内容恰为 y/s/n/a 会直接作出审批决策（tui-input-review2 P2-1）——集成时把粘贴与按键区分开，粘贴不触发单键决策
- [ ] agent-server 提权门禁先于后端可用性判断，codex 后端会给出误导性错误码（foundation review2 P2-1）——集成或下一轮协议单里把顺序换过来
- [ ] agent-tui 模式面板二审剩余 P2×6（短租约释放失败掩盖真实结果、连按 Shift+Tab 吞键、dontAsk 起的线程回不到 dontAsk 且 picker 无当前行、/model 回读与 modelChanged 不同步、非法 --permission 打 ZodError 原文、门禁判定靠英文子串）——集成后统一收尾，见 .fenjue/archive/fj-tui-modes-review2-6edd/out/review.md §三
- [ ] agent-server ThreadManager.fork 对任意 fromItemId 返回 unsupported（只支持从末尾分叉）——Trellis 任意节点分叉需要协议支持 mid-thread fork（trellis-step2 坐席发现，7913839）
- [ ] agent-server 只读命令免审名单（READONLY_AUTO_ALLOW 下沉 daemon）：阶段 2 首单发现 --permission readonly 的 Claude 坐席对每条 Bash 弹审批卡，无人值守会卡住
- [ ] mobile-safe-area-flaky（补充 2026-09-08 20:30：四波集成 fj-trellis-integrate-d-2925 发现集成后的一次失败是确定性 CSS 冲突——AS 页面重复定义 env(safe-area-inset-*)，已修 3b3449f；上线单必须整跑该脚本）: `scripts/mobile-verify/mobile-safe-area.sh` 在机器高负载下（agent-browser CDP 往返 >60s、Chrome 进程 33→44）于「新树 modal 关闭后的下一步」报 daemon busy / Element not found，main@92c6539 基线同样失败（fj-mobile-wave3-nits-d2bb out/result.md §三）：提高该步的重试/等待预算或等 daemon 空闲再点；顺带清理残留的 agent-browser 会话（default / mv-as-project-71361 / mv-as-project-80774 / ship-c，已跑 1 天以上，非当前任务所起）
- [ ] agent-tui-detach-interrupts-turn: fix3 实弹（th_09e01231，2026-09-08 13:58–14:01）：agent-tui 显示端 pane 消失后，AS 上正在跑的首轮 turn 变为 interrupted（41 个 item 后停），fj 报「显示端丢失，AS idle」；显示端退出不应中断引擎 turn——查 agent-tui 退出/崩溃路径是否发 turn/interrupt、daemon 对 owner 断连的策略，并补 PTY 回归；同时查该 pane 为何消失（daemon 刚重启后首个 Claude 坐席）
- [ ] agent-server-readonly-gate-p2s: 只读门线收口后遗留（六审 fj-as-readonly-gate-review3-1d4d §P2-A～D + 五审 P2-3 + 四审 P2-5）：迁移里 CREATE TABLE 字面复制规范 schema 且靠 SELECT * 列序对齐；迁移失败 daemon 起不来无降级；审计行（readonly_auto_allow/denied/tools_disabled/auto_response）无 RPC 出口；readonly 对客户端不 sticky；find/rg/grep/file 参数校验仍是黑名单结构应改白名单
- [ ] agent-tui-herdr-reporter-timeout: 留用坐席 smtk-ingress-review（w2N:p3）空闲约 20 分钟后 agent-tui 状态栏显示「Herdr: Herdr socket timed out」，herdr 查无该 agent，`fj task launch --reuse` 失败（no_output）；查 agent-tui 的 Herdr 上报超时后是否不再重连/重注册，reuse 前应先探活并自动重挂显示端
- [ ] agent-server-busy-after-engine-death: 线程 th_8fd37388（Opus 复核坐席，2026-09-08 17:11）在催醒 turn 中请求 interrupt 后仍 running 超 2 分钟；kill 引擎进程后线程状态变 systemError，但 thread/close 仍报「Thread is busy」，fj seat retire 无法退位（只能直接关 pane）。查 thread-manager 对引擎退出 / interrupt 未收尾时 activeTurn 的清理，close 应在引擎已死时允许；另查为何 TUI 的 interrupt 没生效
- [ ] codex-ingress-slice2-p2s: slice 2 二审（fj-tui-ingress-slice2-review2-d860）遗留 P2×3，见其报告 §P2；并入 slice 4 治理硬化一起收
- [ ] codex-ingress-slice4-p2s: slice 4 复核（fj-tui-ingress-slice4-review-b917）遗留 P2×4，见其报告末尾；集成后一起收

- **codex-ingress-picker-model-save** · P2 · 官方 TUI `/model` picker 保存默认模型会调 `config/batchWrite`，被 ingress 的 config 写 deny 拒绝（TUI 显示 "Failed to save default model"，复现 `.fenjue/archive/fj-ingress-fresh-start-01bb/out/proof/picker.pty`）；`--model <x>` 冷启动可用。可选修法：拦截仅含 `model` 键的 batchWrite 映射为线程级 set_model（不落盘 ~/.codex/config.toml），其余键仍 deny。

- **codex-ingress-upgrade-check-interrupt-flaky** · P2 · 升级回归脚本的 interrupt 判据在真实引擎上不稳定：先是模型自造长输出提前终局/拒绝（三次），改成 sleep 600 确定性阻塞后 Codex Unix 组仍出现 turn 提前 completed（`.fenjue/archive/fj-ingress-fresh-start-01bb/out/proof/`，seq 19 result）。产品修复（冷启动 config 映射）已合 main 88d5e5c，与此无关。修法候选：判据改为「commandExecution item 处于 inProgress 且已持续 ≥3 秒」再发 Esc，并把 sleep 放前台（禁止后台终端）；或对该判据用 mock engine 而非真实引擎。

- **codex-interrupt-leaves-exec-alive** · P1 · 真实 Codex 线程 `turn/interrupt` 有 request+ack、turn 终态 interrupted，但正在跑的 commandExecution 没有 item/completed，且命令子进程（unifiedExec 会话里的 `sleep 600`，PID 11163）10 秒后仍活。证据：fj-ingress-fresh-start-01bb 迟到信件（`.fenjue/archive/fj-ingress-fresh-start-01bb/mail-late-resend.ndjson` 末条）与该 worktree `~/.herdr/worktrees/sm-toolkit/feat-ingress-fresh-start` 的 pty。影响：Trellis/TUI 里「中断」一个 Codex 会话后命令可能继续跑。查法：codex app-server 的 unified exec 会话在 turn/interrupt 后是否按设计保留；若是，daemon 的 codex 引擎需在 interrupt 时显式结束该 turn 的 exec 会话（或杀进程组）并补发 item/completed(failed)。

- **as-adopt-list-noise-grows-with-history** · P2 · 收编服务每 1.5 秒一次 `thread/list` 的底噪随历史累计线程数线性增长（二审 N-1：≈162 条线程即超 100 KB/轮预算），当前生产 ~100 条。修法候选：list 只取非 closed（协议若有筛选）或 daemon 侧分页只返回变化项；空闲时把轮询间隔退避到 5–10 秒。证据 `.fenjue/archive/fj-as-adopt-review2-ebce/out/review2.md` §N-1。

- **deploy-guard-counts-external-sessions** · P2 · `scripts/deploy.ts` 的「有会话正在生成，切换会中断」守卫把收编的外部会话（origin=external / AS 线程绑定的会话）也算成 Trellis 自己的运行，导致 fj 坐席在跑时 `make deploy` 必须 FORCE=1（S164 实测：ed53a1d7 是 observe-retire 坐席的收编会话）。这类会话的 turn 跑在 daemon 上，Trellis 重启只是重连，不会中断。修法：守卫只统计 run-bus 自有运行（binding_type 非 thread 且 origin 非 external），AS 绑定会话另列为提示。
