# S155 · 2026-09-08 09:50–10:35 · 阶段 2 三单（Sonnet）通过；一次冒烟误用 Fable → 加 daemon 模型守卫

## 阶段 2（Claude sonnet 走 agent-tui runner）计数

| # | 单 | 权限 | 起位 | 结果 |
|---|---|---|---|---|
| 1 | as-doc-audit（只读审计，80 行、9 条缺口） | full（readonly 因 P0 中止两次） | 3 | 通过 |
| 2 | as-doc-fix（改 4 份文档 9 条） | full | 1 | 通过 |
| 3 | as-readonly-allow（只读命令免审名单：分类器 + 经纪人 + config；58 单元 + 6 集成） | full | 1 | 通过；复核在跑 |

- 零丢消息、零卡死；起位 5 次成功 3 单（前 2 次失败归 daemon P0，已修）。
- **事故**：#3 的「真机冒烟」用同进程 runDaemon 起线程未显式 model，落到环境默认 `claude-fable-5-1`（2 turn）。契约写了「显式 sonnet」，坐席自述与规则不符。处置：(a) 复核单点名核实并评级；(b) 派 as-model-guard（codex）：thread/start / resume / fork 建线程必须显式 model，denied_models 默认拒绝 fable*，set_model 同受约束，留痕。
- 复核 as-readonly-allow-review（Opus）：名单绕过对抗（管道、子 shell、反引号、find -exec、git 写子命令、env 前缀、绝对路径、heredoc、sed -i 等）+ 显式 sonnet 真机复验。

## 运行面

- daemon pid 78404（feat-agent-server dist，含权限映射修复与 dogfood 合入）在 w4:pJ；policy agent_tui_bin 指 feat-agent-server。
- fj bundle fix3（aab7228…）。

## Next

- 复核与守卫结论 → 返工/收口；阶段 2 继续累计到 10 单（下一批：sm-toolkit 发布准备（版本/CHANGELOG/publish dry-run）、herdr-leader 文档增补（产 patch 由主控合入））。
- 用户待决：Herdr 桥合并上线、影子模式与第二步合并、agent-server 合 main 与发包、daemon 常驻。
