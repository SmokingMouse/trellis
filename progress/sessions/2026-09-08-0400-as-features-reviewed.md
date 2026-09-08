# S148 · 2026-09-08 01:40–04:00 · agent-server 五条特性分支实现 + 异源复核全部收口，集成进行中

## 结果（截至 04:00）

| 分支 | 内容 | 实现 | 复核轮次 | 状态 |
|---|---|---|---|---|
| feat/as-foundation | engineEvent 透传、engineControl 白名单直通、五种权限模式 + 热切（提权需持 lease）、effort、子 agent 正文、bash 输入、compact | codex gpt-6-astra | 2（P1×2 → 修净） | 收口，HEAD 1b168c9 |
| feat/tui-sessions | /new=/clear、/threads、/fork、/resume、断线重连、状态栏 | codex | 2 + 收尾 | 收口 |
| feat/tui-input | 图片、@ 补全（git ls-files → rg → fs 三级回退）、斜杠/skill 补全、多行 | codex | 2（含 3 次验收：rg 依赖、CR 归一） | 收口 |
| feat/tui-modes | Shift+Tab 权限热切、plan 审批卡、effort、/model、/compact、上下文条 | codex | 2（P1×4 权限边界 → 修净） | 收口，P2×6 进 backlog |
| feat/tui-observe | 系统日志带、子 agent 面板、Task list、短租约 | codex | 3（P0 Ctrl-C 门禁、P1 竞态 → 修净） | 收口 |

- 复核位全部 Opus（异源）；每轮反例转正为测试。抓到的高价值问题：readonly 一键被解除、切模式独占 5 分钟租约锁死他端、Ctrl-C 被自加门禁挡死、日志无界致按键延迟 36→209ms、审批回复竞态卡死 30 秒。
- 集成拆两步：as-integrate2（四分支 → feat/agent-server，在跑，真引擎冒烟已过：Sonnet plan 启动 + 持 lease 切 acceptEdits + 图片 + hook engineEvent；gpt-6-astra 普通档）→ as-integrate2b（合 tui-observe + 复验）。
- 决策：AS 不做隐式提权策略（见 decisions.md 2026-09-08）。

## 实弹经验

- 特性分支基于打底分支再开分支时，打底随后返工会改变语义（lease 门禁）：契约里预告「集成时 rebase 并对照返工结果」，复核者顺带核冲突点，有效。
- 只查「结论行存在」的 verify 会把「需返工」也判成验收通过 → 计划把 review 标完成后下游变可起。leader 必须读 verdict 再放行；集成拆步可避免被单个返工卡住。
- codex 验收侧与坐席侧 PATH 差异（rg 只是别名）导致同一测试两侧结果不同：契约里要求在 `env -i … PATH=/usr/bin:/bin:$(dirname $(command -v bun))` 下复跑。
- 同一 worktree 两单先后跑，后者 settle 会把前者已提交的差异判越界：改 task.json base_commit 到 HEAD 再 `fj settle --force`。

## Next

- as-integrate2 返工（daemon-pty 用例把 Herdr 提前输出的 OSC thread id 当输入就绪）→ 验收 → as-integrate2b → dogfood-impl（焚决仓需开 worktree）→ trellis-step2。
- backlog：模式面板 P2×6、输入 P2-1（粘贴 y/n 触发审批）、AS 提权门禁与后端判断顺序、协议只读 pending-request 通知。
- 用户待决：Herdr 桥合并上线、影子模式合并、agent-server 合 main 与发包。
