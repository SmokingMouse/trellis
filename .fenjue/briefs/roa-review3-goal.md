目标：三审只读命令免审名单（现已改为 fail-closed 白名单解析器，实现单 fj-as-readonly-allow-fix2-f53a 已验收，代码在 packages/agent-server/src/engines/readonly-commands.ts 与 claude.ts）。你是 Opus 复核坐席，只读，产物落 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/review.md`。

必做：
1. 历史向量全部重打：一审 `.fenjue/archive/fj-as-readonly-allow-review-*/out/`、二审 `.fenjue/archive/fj-as-readonly-allow-review2-5f0a/out/` 里列过的每一条绕过（管道/子 shell/反引号/find -exec 与 -fls/git 写子命令与 --output/git branch 写形式/env 前缀与 env -S/别名/绝对路径/heredoc/sed -i/换行与单 & 分隔/双引号内 $(…)/rg --pre 与 --hostname-bin/git 全局 flag/注释），逐条给出「现在的判定 + 证据（测试名或直接调用分类器的输出）」。
2. 新造向量：针对白名单解析器本身——引号与转义边角（\n、\x、$'…'、未闭合引号）、Unicode 空白与全角字符、行内 CR、连接符组合（`;;`、`|&`、`&&&`）、选项白名单绕过（`--` 之后的参数、短选项合并如 `-rl`、`=` 形式、重复选项）、argv[0] 解析（相对路径、`./cat`、含斜杠、PATH 劫持、符号链接、大小写）、极长输入与深嵌套、超时/性能（解析器是否可能被灌到卡住）。每条给判定与证据。
3. fail-closed 性质核对：解析失败、未知命令、未知选项、任何替换/重定向 → 一律走审批而不是放行；审计持久化仍在（approvals 表有 auto_allow 记录）。
4. 真机一次：显式 `--model sonnet` 起线程（禁止落到环境默认模型；冒烟脚本必须断言 init 帧的 model 字段），在 readonly/plan 线程里跑一条名单内命令与一条名单外命令，前者零 pendingRequests、后者产生审批。冒烟证据（thread id、init 帧 model、pendingRequests 计数）写进 review.md。

评级：P0（可绕过放行写操作）/ P1（fail-closed 破缺或审计缺失）/ P2（覆盖面或体验）。结论只能是「通过」或「需返工（列 P0/P1）」。不改任何源码；临时文件只放 mktemp 目录。
