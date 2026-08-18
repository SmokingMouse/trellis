# Trellis Progress

## Current Focus
授权健康监控（T0 状态卡 + T1 预警）已落地待验收；验收队列见指针区，BOE 仍未部。

## Goals

- [ ] **自定义 Agent + 自动化任务** → [计划](custom-agents-plan.md) · [ADR](decisions/2026-07-31-custom-agents.md)
  A1-A4（人设 / 技能物化 / 管理界面 / @提及）· T1-T4（任务 / cron / 通知 / 事件触发）全部落地并逐条实测。
  SDK 0.4.0 已发 npm，本机 prod 已上线（`ce3b5fba6`，真库迁移 + 5 个内置 agent + 44 会话无损）。
  **待办：BOE 未部**（本机 ssh 不通，需在 devbox 上手跑，命令见 `sessions.md` 的 S88 Next）。
- [ ] **S1: Project/Workspace 层级 + 工作区终端** → [spec](project-workspace-layer.md) · [ADR](decisions/2026-07-27-project-workspace-layer.md)
  P0/P1/P2 均已落地。判据是**行为指标**（一周内 worktree 里的 session 数 > 0），首轮实测为 0；
  S83、S87 各修掉一批可用性堵点后重新计时。S2/S3/S4 依赖它，见 ADR。
- [ ] **替代 CLI + GPT 客户端** → [roadmap](roadmap-2026q2.md) · [工作台](session-workbench.md) · [体验优化](optimization-roadmap.md)
  Codex 主链已对齐（attach/同步/分叉/CLI 续聊/skill/Agent/cached web）；逐项审批待 app-server。余 Stage 20/21、工作台 Wave 1、Level B store 重构。

> 逐条明细（含全部已完成与暂缓理由）在 `archive.md` 的「Goals 归档」。

## 指针区

- `facts.md` 已验证事实（改代码前读） · `failures.md` 待查 / 已结案（排查 bug 前读）
- `sessions.md` 最近 5 条 log（S99–95） · `archive.md` 更早 log + Goals 归档 + 历史 Focus 栈
- `happyclaw-contrast.md` 对照剖析；开新方向前查「已排除」节
- **待验收**：`console-ia-spec.md` · `skills/trellis-admin/` · S91 三处 · S94 卡片图弹窗 · S95 授权卡+预警
- `decisions.md` · `decisions/` 轻量决策 / ADR · `blocks/` 并行 worktree 独占块
- 其余 `*.md` 为按需读取的 feature spec
