# S149 · 2026-09-08 04:00–04:35 · 五分支集成完成（feat/agent-server 7913839），fj dogfood 实现起跑

## 集成

- as-integrate2（四分支）→ 验收首次失败，根因：daemon-pty 用例把 Herdr 提前输出的 OSC thread id 当输入就绪 → 改为等原始输入帧再敲键（5451ce4），定向 10/10。
- as-integrate2b（合 tui-observe）→ blocker：模式面板与观测面板的租约生命周期矛盾（30 秒到期不续 vs 无限续租）。**leader 裁决**：统一租约管理器承接发送/审批/提权（操作前取、进行中续、完成即放）；非提权切换不取租约；手动 /takeover 仅活跃时续期、空闲到期、/release 显式放手；ExitPlanMode 走同一审批路径、仅本端获胜切 default；租约按 thread 隔离，切会话释放旧租约不复用。合并提交 eccdf6d「activity-bound thread leases」。
- 最终：server 263 pass、TUI 普通/干净环境各 116 pass、typecheck 绿、codex 对齐脚本绿；真引擎复验：Sonnet 同 thread 3 turn（plan 启动 → 持 lease 切 acceptEdits → 图片 → hook engineEvent；Ctrl-C 急停不受租约影响）、gpt-6-astra 普通档。feat/agent-server HEAD **7913839**（未 push、未合 main）。
- 集成报告对 backlog 的处置建议：模式面板 P2-1（释放失败掩盖结果）已随统一租约消除，建议结案；P2-2～P2-6 另开收尾单；审批卡粘贴决策、门禁与后端判断顺序仍留原单。

## dogfood 起跑

- 焚决仓（`~/ai-coding/焚决`，fj 源码 src/cli + src/core，bundle 到 herdr-leader/scripts/fj.js）开 worktree `feat/agent-tui-runner`（Herdr w2B）；sm-toolkit 开 `feat/dogfood`（w2C，基于 7913839）。
- dogfood-impl（codex gpt-6-astra，keep-seat）：方案 §8 的 A（fjContext 受限协议）、B（agent-tui 参数/ready-file/Herdr 上报）、C1–C3（fj --runner、RPC 注入、AS 状态判停滞、bundle 只产到仓内不安装）、D（launchd 模板不安装）、F（runners/agent-tui.md 等文档）；阶段 0 mock 预验收。verify 含「主控在用的 fj.js 未被改动」（cmp 基线 /tmp/fj.js.baseline-dogfood）。
- 后续：dogfood-review（Opus，起一个真 codex 坐席跑玩具契约走完 launch→mail→settle）→ 阶段 1（Codex 10 单）→ trellis-step2。

## Next / 待用户

- 集成后 backlog 收尾单（模式面板 P2×5、粘贴决策、门禁顺序）排在 dogfood 之后。
- 用户待决：Herdr 桥合并上线、影子模式合并、agent-server 合 main 与发包。
