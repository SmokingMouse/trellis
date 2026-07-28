# Trellis Progress

## Current Focus
更新扳机已从命令行挪进设置页（`/settings` 点一下就发，仍是显式动作）；S1 工作平台化的 P0+P1 已上线，正停一周看行为判据。

## Goals

- [ ] **S1: Project/Workspace 层级 + 工作区终端** → [spec](project-workspace-layer.md) · [ADR](decisions/2026-07-27-project-workspace-layer.md)
  P0（两表 + 自动聚类 + 侧栏三级）与 P1（ttyd/tmux 终端）已上线，P2（git 状态角标 + 新建/回收 workspace）未开工。
  判据是**行为指标**：一周内 worktree 里的 session 数 > 0 —— 不是功能做完。S2/S3/S4 依赖它，见 ADR。
- [ ] **2026 Q2：替代 Claude Code CLI + GPT 客户端** → [roadmap](roadmap-2026q2.md) · [工作台层](session-workbench.md)
  未做：Stage 18 Skill 入口 / Stage 20 Plan 节点 / Stage 21 Memory 桥接；工作台 Wave 1 三项 + Level B store 重构。
- [ ] **GPT 替代体验优化** → [optimization-roadmap.md](optimization-roadmap.md)
  P0/P1/P2 已清。余下 C3 语义检索 / C5 session 级模型 / A6 命令面板 / B3 长回复 TOC / C6 图片语音**均已评估暂缓**，理由在归档里；D3 工具结果闭环待确认底层是否已覆盖。

> 逐条明细（含全部已完成 `[x]` 与暂缓理由）在 `archive.md` 的「Goals 归档」。

## 指针区

- `facts.md` — 已验证事实（改代码前读）
- `failures.md` — 待查 / 已结案失败（排查 bug 前读）
- `sessions.md` — 最近 5 条 session log（Session 80/79/78/77/75）
- `archive.md` — 更早的 session log（Session 74–1）+ Goals 归档 + 历史 Current Focus 栈
- `decisions.md` · `decisions/` — 轻量决策日志 / 重量 ADR
- `blocks/` — 并行 worktree 独占进度块
- 其余 `*.md` 均为 feature spec，被上面的 Goals 指到时才读（`ls progress/` 即清单）
