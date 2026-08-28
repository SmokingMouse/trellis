# Trellis Progress

## Current Focus
S4 二期统一门户（S128）双单交付，余契约C接线联调（涉重启宿主 prod 待拍板）；S121-S128 待 make deploy；公网接入待拍板；cpa codex 故障在查（failures.md）。

## Goals

- [ ] **S4: 多租户开放（实例级隔离 + 统一门户）** → [运维手册](../tenancy/README.md) · [一期 ADR](decisions/2026-08-28-multi-tenancy-instance-isolation.md) · [二期 ADR](decisions/2026-08-28-multi-tenancy-unified-portal.md)
  一期四单+二期双单全 settle pass；余：接线联调（宿主入网关+真容器端到端）、公网接入（待拍板）。
- [x] **自定义 Agent + 自动化任务** → [计划](custom-agents-plan.md) · [ADR](decisions/2026-07-31-custom-agents.md)
  A1-A4 · T1-T4 全部落地实测，本机 prod 已上线，开发完结。残留运维待办：BOE 未部（见 sessions.md S88 Next）。
- [ ] **S1: Project/Workspace 层级 + 工作区终端** → [spec](project-workspace-layer.md) · [ADR](decisions/2026-07-27-project-workspace-layer.md)
  P0/P1/P2 均已落地，S83/S87 修掉可用性堵点后计时观测。S2/S3/S4 依赖它。
- [ ] **替代 CLI + GPT 客户端** → [roadmap](roadmap-2026q2.md) · [工作台](session-workbench.md) · [体验优化](optimization-roadmap.md)
  Codex 主链对齐，余 Stage 20/21、工作台 Wave 1、Level B store 重构。

> 逐条明细在 `archive.md` 的「Goals 归档」。

## 指针区

- `facts.md` 已验证事实 · `failures.md` 待查 / 已结案
- `sessions.md` 最近 5 条 log（S126–122） · `archive.md` 更早 log + Goals 归档 + 历史 Focus 栈
- `happyclaw-contrast.md` 对照剖析；开新方向前查「已排除」节
- **待验收**：`console-ia-spec.md` · `skills/trellis-admin/` · S91/S94/S95
- `decisions.md` · `decisions/` 轻量决策 / ADR · `blocks/` 并行 worktree 独占块
- 其余 `*.md` 为按需读取的 feature spec
