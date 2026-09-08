# S153 · 2026-09-08 08:30–09:20 · 阶段 1 满 10 单收官；阶段 2（Claude 坐席）首单与首个发现

## 阶段 1 结论（对照 dogfood 方案 §7 退出标准）

| 标准 | 结果 |
|---|---|
| 连续 10 单无 AS 契约/控制消息丢失或重复 | 10/10 通过（#1 as-polish2 … #10 tui-modal-router），无一例丢失/重复 |
| 无审批卡死 | 无（codex 走 `-a never` 等价的 full 权限） |
| serviceTier 始终 default | 每单 launch 参数显式 default，fix3 后 serviceTier 真生效并有测试 |
| 同线程仅一个引擎 | 每单 thread 唯一、首轮 turn 唯一（fj 幂等交接） |
| settle 首轮通过率 ≥ native 基线 | 10/10 首轮通过（#7 因 verify 写成移动靶改判后通过）；native 近期基线首轮 ≈ 0.75（tui-input 3 次、integrate2 2 次、step2 2 次） |
| 基础设施失败 | 1 次（首次起位缺 FJ_AGENT_TUI_BIN，fix3 已预检 + policy 持久化），计入分母 |

**判定：阶段 1 通过，进入阶段 2。** 同时暴露并修掉的 runner 问题：silent pane run、ready 旁路、herdr 不可用泄漏、close 拒关、可执行预检（dogfood-fix ×3）。

## 阶段 2 首单（Claude sonnet，只读契约，agent-tui runner）

- as-doc-audit：起位一次成功，daemon 起的 claude 显式 sonnet（TUI 状态栏 model sonnet）。
- **首个发现**：`--permission readonly` 下 Claude 对每条 Bash（`find`、`ls`）都弹审批卡，无人值守时会卡住；fj next 正确报「AS 阻塞 pendingRequests=2」。leader 用 `herdr pane send-keys <pane> s` + `enter`（本会话允许）走通了人工审批路径，卡片显示「已由 agent-tui 处理」。结论：readonly 契约的 Claude 坐席应以 `--permission full` 起（越界由 settle 兜底），或给 daemon 加只读命令免审名单（方案里的 READONLY_AUTO_ALLOW，记 backlog）。

## TUI 终审

- tui-modal-router（#10）合入命令面 + 统一模态焦点栈，300 格穿透矩阵；终审 tui-router-review 在跑（复用 Opus 审阅坐席）。

## Next

- 终审结论 → 返工或收口；doc-audit 结论 → 文档修正单（阶段 2 #2，可 writable）。
- 阶段 2 继续累计 10 单（先 readonly 再 writable），随后阶段 3 扩大并发。
- 用户待决：Herdr 桥合并上线、影子模式与第二步合并、agent-server 合 main 与发包、daemon 常驻（launchd）。
