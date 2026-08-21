# Trellis Progress

## Current Focus
画布完全剔除隐藏树并支持思维树大纲分组恢复已落地（S116）；cpa codex 故障在查（failures.md）。

## Goals

- [ ] **自定义 Agent + 自动化任务** → [计划](custom-agents-plan.md) · [ADR](decisions/2026-07-31-custom-agents.md)
  A1-A4 · T1-T4 全部落地实测。本机 prod 已上线。待办：BOE 未部（需 devbox 手跑，见 sessions.md S88 Next）。
- [ ] **S1: Project/Workspace 层级 + 工作区终端** → [spec](project-workspace-layer.md) · [ADR](decisions/2026-07-27-project-workspace-layer.md)
  P0/P1/P2 均已落地，S83/S87 修掉可用性堵点后计时观测。S2/S3/S4 依赖它。
- [ ] **替代 CLI + GPT 客户端** → [roadmap](roadmap-2026q2.md) · [工作台](session-workbench.md) · [体验优化](optimization-roadmap.md)
  Codex 主链对齐，余 Stage 20/21、工作台 Wave 1、Level B store 重构。

> 逐条明细在 `archive.md` 的「Goals 归档」。

## 指针区

- `facts.md` 已验证事实 · `failures.md` 待查 / 已结案
- `sessions.md` 最近 5 条 log（S116–112） · `archive.md` 更早 log + Goals 归档 + 历史 Focus 栈
- `happyclaw-contrast.md` 对照剖析；开新方向前查「已排除」节
- **待验收**：`console-ia-spec.md` · `skills/trellis-admin/` · S91/S94/S95
- `decisions.md` · `decisions/` 轻量决策 / ADR · `blocks/` 并行 worktree 独占块
- 其余 `*.md` 为按需读取的 feature spec
