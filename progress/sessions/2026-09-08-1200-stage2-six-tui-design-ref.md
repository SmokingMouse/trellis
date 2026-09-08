# S156 · 2026-09-08 10:35–12:00 · 阶段 2 累计 6 过 6；只读名单改 fail-closed 白名单；用户改向：agent-tui 参考本地 Claude Code 源码核心设计

## 阶段 2（Claude 坐席走 agent-tui runner）计数

| # | 单 | 起位 | 结果 |
|---|---|---|---|
| 4 | as-readonly-allow-fix（修一审 P0×3/P1×3/P2×4） | 1 | 通过 |
| 5 | as-readonly-allow-fix2（二审又打穿 `"$(…)"`、`env -S`、`rg --pre` → leader 裁决改 fail-closed 白名单解析器，两轮向量转正 + 50 条模糊组合） | 1 | 通过（agent-server 452 测试全绿） |
| 6 | skill-docs-sync（herdr-leader 技能文档双向同步，焚决仓） | 2（首次 pane_not_found，见下） | 通过；install.patch 已应用到安装副本（新增 references/runners/agent-tui.md，SKILL/playbook/seats 纯追加） |
| 7 | mobile-wave3-nits（C2-1/C2-2/C2-3/H-3，分支 feat/mobile-nits-wave3） | 1 | 在跑 |
| 8 | as-readonly-allow-review3（Opus 三审：全部历史 + 新造向量，真机显式 sonnet 并断言 init 帧 model） | 复用坐席 | 在跑 |
| 9 | cc-tui-design（Opus，只读调研，见下） | 1 | 在跑 |

- 零丢消息、零审批卡死。基础设施失败 2 次：(a) 退掉 dogfood 留用坐席时它是焚决 worktree 工作区最后一个 pane，工作区随之消失 → `herdr worktree open` 重开后起位；(b) codex 坐席 `--permission readonly` 下沙箱只读，报告无法落盘 out/ → 中止重开为 full（只读契约靠 settle 越界审计兜底，与 Claude 侧结论一致）。fj 重试不允许改已持久化的 permission，只能关单重开。
- mobile-wave1-nits（第 8 单候选）排在 wave3 之后：手机验收脚本固定占 3471–3478 端口与 `/tmp/trellis-mobile-verify.lock`，并行会互相打架（S152 已为此返工两次）。

## 用户改向：agent-tui 不从零发明，参考 Claude Code 核心设计

- 本地源码在 `~/python/ai/claude-code`（2026-03 source map 泄露快照，TS + Bun，1902 文件 51 万行，`src/ink/` 深度 fork 的 Ink；笔记 `ai-studio/articles/claude-code-源码架构分析.md` 是已有地图）。
- 派两路只读调研同跑：cc-tui-design（Opus：渲染栈 fork、消息模型、输入与按键、模态焦点、模式与状态栏、命令面、多 agent 呈现、server/remote 的 UI 内核分离形态，产「照抄 / 不要 / 绕开」三表）+ tui-self-audit2（codex gpt-6-astra 异源：我们 agent-tui 的技术栈、交互成熟度、结构性坑、协议耦合面、可留可换）。两份齐后 tui-adoption-plan（Opus）写分阶段方案供用户拍板。
- 约束：私有源码只做设计参考，不整段抄代码；渲染层若用 Ink 走上游 MIT 版。

## 运行面

- daemon pid 19156（feat-agent-server dist，含模型守卫；只读名单 fix/fix2 尚未进 dist，三审通过后重建重启）。fj bundle fix3 不变；安装副本文档已打 patch。

## Next

- 三审结论 → 返工或收口 → 重建 dist 重启 daemon；wave3 验收 → 起 wave1；两份调研 → 方案单 → 用户拍板后拆实现单。
- 阶段 2 满 10 单写结论；用户待决：Herdr 桥合并上线、影子模式与第二步合并、agent-server 合 main 与发包、daemon 常驻。
