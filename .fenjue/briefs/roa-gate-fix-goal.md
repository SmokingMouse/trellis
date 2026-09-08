目标：修三审 P0-1（复核报告 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-as-readonly-allow-review3-8b89/out/review.md` 的 §P0-1 与 Run 1–3）。现象：readonly（当前实现为 plan 模式的别名）线程里，Claude CLI 对 Bash 不发 can_use_tool，daemon 的免审名单与审批经纪人（packages/agent-server/src/engines/claude.ts:308-330）一次都没进；名单外写命令 `touch` 无审批执行、pendingRequests=0、approvals 表零行。解析器本体 186 例零绕过，不用动。

leader 裁决：只读必须由 daemon 强制且 fail-closed，不能依赖 CLI 的 plan 模式。

1. 先诊断（写 out/diagnosis.md）：dump readonly/plan 线程实际 argv（是否带 `--permission-prompt-tool stdio` 与 `--settings permissions.ask=["*"]`）；直接用 `claude -p --permission-mode plan` 加同样 settings 复现 Bash 写命令是否回传 can_use_tool；给出根因（CLI 行为 vs 我们 argv 缺失）。
2. 把 readonly 与 plan 拆开：
   - readonly = 引擎 default 模式 + ask:["*"] + `--disallowedTools Edit,Write,MultiEdit,NotebookEdit`（防御纵深）+ 经纪人在 readonly 线程对写类工具直接拒绝并留痕，Bash 走白名单解析器、否则审批。
   - plan = CLI 原生 plan 模式（用户交互用），同样叠加 ask:["*"] 与 disallowedTools；若诊断证明 CLI plan 模式下 Bash 不回传 can_use_tool，则 plan 线程的 Bash 也必须由 daemon 兜底（可选：plan 线程改用 default 模式 + 注入 plan 语义的 system prompt；写清取舍与代价）。
3. 测试：五种模式 argv 单测更新；经纪人测试——readonly 线程 `touch` → 产生审批且不执行，`Edit` → 拒绝并留痕，名单内 `ls` → auto_allow 留痕。
4. 真机冒烟（显式 `--model sonnet`，脚本断言 init 帧 model）：readonly 线程 `ls`（免审放行、approvals 有 auto_allow 行）、`touch /tmp/<mktemp>/x`（pendingRequests=1 且文件不存在）、Edit（拒绝）；default 线程对照产生审批；plan 线程按第 2 条的最终方案断言。三次 run 全过，证据（thread id、init 帧 model、pendingRequests 计数、approvals 行）写进 out/result.md。
5. 顺手修 P2-1（rg 在 PATH 上不可解析时跳过并留痕）、P2-3（resolveExecutableDir 缓存）、P2-4（空白判定与 shell IFS 一致）、P2-5（find/rg/grep/file 改成选项白名单）；P2-2（函数/别名优先于 PATH）写进文档的已知限制。

更新 docs/agent-server 的权限章节。产物目录 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/`。提交到本分支。
