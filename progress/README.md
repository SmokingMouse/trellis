# Trellis Progress

## Current Focus
树隐藏问题修复（彻底移出非隐藏区 + 焦点自动切换 + 已隐藏组自适应），提交 PR 并合入 main。

## Goals

- [ ] **自定义 Agent + 自动化任务** → [计划](custom-agents-plan.md) · [ADR](decisions/2026-07-31-custom-agents.md)
  A1-A4 · T1-T4 落地实测。SDK 0.4.0 已发，本机 prod 已上线。待办：BOE 未部。
- [ ] **S1: Project/Workspace 层级 + 工作区终端** → [spec](project-workspace-layer.md) · [ADR](decisions/2026-07-27-project-workspace-layer.md)
  P0/P1/P2 均已落地。S83、S87 修掉可用性堵点后重新计时。S2/S3/S4 依赖它。
- [ ] **替代 CLI + GPT 客户端** → [roadmap](roadmap-2026q2.md) · [工作台](session-workbench.md)
  Codex 主链已对齐（attach/同步/分叉/续聊/skill/Agent）；逐项审批待 app-server。

> 逐条明细在 `archive.md` 的「Goals 归档」。

## 指针区

- `facts.md` 已验证事实 · `failures.md` 待查 / 已结案
- `sessions.md` 最近 5 条 log · `archive.md` 更早 log + Goals 归档
- `happyclaw-contrast.md` 对照剖析 · `decisions.md` 决策记录
- 其余 `*.md` 为按需读取的 feature spec
