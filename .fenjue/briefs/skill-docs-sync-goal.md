目标：把 herdr-leader 技能的两份副本对齐（阶段 2 试点第 6 单，你是 Claude sonnet 坐席，走 agent-tui runner）。

源 A = 本 worktree 的 `skill/`（焚决契约治理层；dogfood 各单在这里新增了 agent-tui runner 的文档与 Known Failure Modes）。
副本 B = 安装副本 `/Users/smokingmouse/.claude/skills/herdr-leader/`（AgentBuddy 合并版：多出 references/{cleanup,fleet,naming,onboarding,selection,setup}.md 与 references/runners/{claude,codex,custom,grok,opencode}.md；leader 在 references/seats.md 末尾手工追加了 3 条实弹记录：fable 冒烟误用、readonly 审批卡、ctrl-c 与 busy close）。
硬约束：B 只读——禁止写 `~/.claude/` 下任何文件（验收会用 mtime 抓）；`skill/scripts/fj.js` 一字不动（验收比 sha）；不搬 B 的合并层文件进 A。

交付物：
1. 回灌 B→A：把 B 的 seats.md 里 A 没有的实弹条目合进 `skill/references/seats.md`（保持 A 的表结构）；B 的 SKILL.md / playbook.md / provenance.md 里只搬 A 缺的事实性更新（agent-tui runner 规则、Known Failure Modes、模型硬规则），合并层的组织性文字不搬。
2. 前灌 A→B：A 里 dogfood 单新增的 agent-tui runner 文档——`--runner native|agent-tui` 调用面与 `fj task launch <cid> --runner agent-tui --kind claude|codex --name … --model … --permission full|readonly [--service-tier default] --anchor <ws>:p1` 语法、FJ_RUNNER_DEFAULT、`skill/runners/` 下的 agent-tui 说明、policy frontmatter 的 `agent_tui_bin`（优先级 FJ_AGENT_TUI_BIN > policy > PATH）、握手未完成时的中止与恢复指令（fj task close、恢复命令带 --token-path）、agent-tui 相关 Known Failure Modes——整理成 B 可用的形态，写成 `out/install.patch`：对 B 的 unified diff，`patch -p1` 可用，根为 `~/.claude/skills/herdr-leader`；A 的 `skill/runners/` 内容落到 B 的 `references/runners/agent-tui.md`（新文件用 `--- /dev/null` 形式）；只含文档、不含 fj.js。写之前先在 mktemp 目录复制一份 B 做演练，确认 `patch -p1 --dry-run` 干净。
3. `out/sync-report.md`：逐文件列差异归类（A 新增 / B 合并层独有 / 冲突与取舍）、patch 改了 B 哪些段落且 B 原有段落全部保留的自证清单、一行 apply 命令。

产物目录 `out/` 指本单任务目录 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/`。A 侧改动提交到本分支（可多个 commit），`bun test` 保持绿。
