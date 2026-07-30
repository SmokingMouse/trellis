# Trellis Progress

## Current Focus
两台实例都待重部（S85 修复未生效）；devbox 部署通路刚跨平台修好（S86），先在那儿实跑 install-service + deploy。S1 堵点与动线重做待验收。

## Goals

- [ ] **S1: Project/Workspace 层级 + 工作区终端** → [spec](project-workspace-layer.md) · [ADR](decisions/2026-07-27-project-workspace-layer.md)
  P0（两表 + 自动聚类 + 侧栏三级）· P1（ttyd/tmux 终端）· P2（新建回收 + git 状态角标）均已落地。
  判据是**行为指标**：一周内 worktree 里的 session 数 > 0 —— 不是功能做完。**首轮实测为 0**，S83 修掉三个堵点
  （按钮触屏点不到 / 侧栏显示已删除的 worktree 且看不见新建的 / 无 git 状态）后重新计时。S2/S3/S4 依赖它，见 ADR。
- [ ] **2026 Q2：替代 Claude Code CLI + GPT 客户端** → [roadmap](roadmap-2026q2.md) · [工作台层](session-workbench.md)
  未做：Stage 18 Skill 入口 / Stage 20 Plan 节点 / Stage 21 Memory 桥接；工作台 Wave 1 三项 + Level B store 重构。
- [ ] **GPT 替代体验优化** → [optimization-roadmap.md](optimization-roadmap.md)
  P0/P1/P2 已清。余下 C3 语义检索 / C5 session 级模型 / A6 命令面板 / B3 长回复 TOC / C6 图片语音**均已评估暂缓**，理由在归档里；D3 工具结果闭环待确认底层是否已覆盖。

> 逐条明细（含全部已完成 `[x]` 与暂缓理由）在 `archive.md` 的「Goals 归档」。

## 指针区

- `facts.md` — 已验证事实（改代码前读）
- `failures.md` — 待查 / 已结案失败（排查 bug 前读）
- `sessions.md` — 最近 5 条 session log（Session 84/83/82/81/80）
- `archive.md` — 更早的 session log（Session 79–1）+ Goals 归档 + 历史 Current Focus 栈
- `decisions.md` · `decisions/` — 轻量决策日志 / 重量 ADR
- `blocks/` — 并行 worktree 独占进度块
- 其余 `*.md` 均为 feature spec，被上面的 Goals 指到时才读（`ls progress/` 即清单）
