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
- [ ] mobile-safe-area-flaky: `scripts/mobile-verify/mobile-safe-area.sh` 在机器高负载下（agent-browser CDP 往返 >60s、Chrome 进程 33→44）于「新树 modal 关闭后的下一步」报 daemon busy / Element not found，main@92c6539 基线同样失败（fj-mobile-wave3-nits-d2bb out/result.md §三）：提高该步的重试/等待预算或等 daemon 空闲再点；顺带清理残留的 agent-browser 会话（default / mv-as-project-71361 / mv-as-project-80774 / ship-c，已跑 1 天以上，非当前任务所起）
- [ ] agent-tui-detach-interrupts-turn: fix3 实弹（th_09e01231，2026-09-08 13:58–14:01）：agent-tui 显示端 pane 消失后，AS 上正在跑的首轮 turn 变为 interrupted（41 个 item 后停），fj 报「显示端丢失，AS idle」；显示端退出不应中断引擎 turn——查 agent-tui 退出/崩溃路径是否发 turn/interrupt、daemon 对 owner 断连的策略，并补 PTY 回归；同时查该 pane 为何消失（daemon 刚重启后首个 Claude 坐席）
- [ ] agent-server-readonly-gate-p2s: 只读门线收口后遗留（六审 fj-as-readonly-gate-review3-1d4d §P2-A～D + 五审 P2-3 + 四审 P2-5）：迁移里 CREATE TABLE 字面复制规范 schema 且靠 SELECT * 列序对齐；迁移失败 daemon 起不来无降级；审计行（readonly_auto_allow/denied/tools_disabled/auto_response）无 RPC 出口；readonly 对客户端不 sticky；find/rg/grep/file 参数校验仍是黑名单结构应改白名单
- [ ] agent-tui-herdr-reporter-timeout: 留用坐席 smtk-ingress-review（w2N:p3）空闲约 20 分钟后 agent-tui 状态栏显示「Herdr: Herdr socket timed out」，herdr 查无该 agent，`fj task launch --reuse` 失败（no_output）；查 agent-tui 的 Herdr 上报超时后是否不再重连/重注册，reuse 前应先探活并自动重挂显示端
- [ ] agent-server-busy-after-engine-death: 线程 th_8fd37388（Opus 复核坐席，2026-09-08 17:11）在催醒 turn 中请求 interrupt 后仍 running 超 2 分钟；kill 引擎进程后线程状态变 systemError，但 thread/close 仍报「Thread is busy」，fj seat retire 无法退位（只能直接关 pane）。查 thread-manager 对引擎退出 / interrupt 未收尾时 activeTurn 的清理，close 应在引擎已死时允许；另查为何 TUI 的 interrupt 没生效
- [ ] codex-ingress-slice2-p2s: slice 2 二审（fj-tui-ingress-slice2-review2-d860）遗留 P2×3，见其报告 §P2；并入 slice 4 治理硬化一起收
- [ ] codex-ingress-slice4-p2s: slice 4 复核（fj-tui-ingress-slice4-review-b917）遗留 P2×4，见其报告末尾；集成后一起收
