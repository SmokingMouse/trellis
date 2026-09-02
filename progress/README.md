# Trellis Progress

## Current Focus
飞书链路已通（ws 内联根因修掉，私聊实测回包），IM 入口层四旋钮与话题即树已上线待群内四步验收；侧栏最近分组同批上线；路线重锚（先 dogfood 还是先公网）仍待拍板。

## Goals

- [ ] **S4: 多租户开放（实例级隔离 + 统一门户）** → [运维手册](../tenancy/README.md) · [一期 ADR](decisions/2026-08-28-multi-tenancy-instance-isolation.md) · [二期 ADR](decisions/2026-08-28-multi-tenancy-unified-portal.md)
  一期四单+二期双单+契约C接线（S130）全落地，本机多租户体系已上线；余：公网接入（待拍板）。
- [x] **自定义 Agent + 自动化任务** → [计划](custom-agents-plan.md) · [ADR](decisions/2026-07-31-custom-agents.md)
  A1-A4 · T1-T4 全部落地实测，本机 prod 已上线，开发完结。残留运维待办：BOE 未部（见 sessions.md S88 Next）。
- [ ] **S1: Project/Workspace 层级 + 工作区终端** → [spec](project-workspace-layer.md) · [ADR](decisions/2026-07-27-project-workspace-layer.md)
  P0/P1/P2 均已落地，S83/S87 修掉可用性堵点后计时观测。S2/S3/S4 依赖它。
- [ ] **替代 CLI + GPT 客户端** → [roadmap](roadmap-2026q2.md) · [工作台](session-workbench.md) · [体验优化](optimization-roadmap.md)
  Codex 主链对齐，余 Stage 20/21、工作台 Wave 1、Level B store 重构。

> 逐条明细在 `archive.md` 的「Goals 归档」。

## 指针区

- `facts.md` 已验证事实 · `failures.md` 待查 / 已结案
- `backlog.md` 需求侧摩擦队列（项目级扩展，不在全局协议内；定活前读，open ≤10 条）
- `sessions/` 一条一文件、按文件名倒序读最近 5 个（最新 S134；本日两条 S133 撞号并存（文件名为键）；`0000-legacy.md` = S132–128 存量） · `archive.md` 更早 log + Goals 归档 + 历史 Focus 栈
- `happyclaw-contrast.md` 对照剖析；开新方向前查「已排除」节
- **待验收**：`console-ia-spec.md` · `skills/trellis-admin/` · S91/S94/S95
- `decisions.md` · `decisions/` 轻量决策 / ADR · `blocks/` 并行 worktree 独占块
- `im-entry-layer.md` IM 入口层 spec（飞书四旋钮 / 话题即树 / @slug）
- 其余 `*.md` 为按需读取的 feature spec
